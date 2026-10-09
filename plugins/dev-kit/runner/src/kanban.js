/**
 * Close the Kanban loop from the runner.
 *
 * Task 016 gave this job to a GitHub push webhook. No webhook was ever registered
 * on the repo (`gh api repos/<r>/hooks` → `[]`) and GITHUB_WEBHOOK_SECRET was never
 * configured, so a finished task never moved its card, never reported what it did,
 * and never filed its follow-ups. The runner knows all three the moment a task ends
 * and needs no deploy, so it says so directly. The webhook stays idempotent with
 * this: it skips a card that is already past TODO.
 */

import { readdirSync, readFileSync } from "node:fs";
import { basename, join } from "node:path";
import { reportToIssue } from "./issue.js";
import { stemOf } from "./queue.js";

// The exact marker buildTaskFile() writes, anchored to the start of its own line:
// a follow-up file quotes its parent as "(from Kanban card `…`)" and must not match.
const CARD_ID = /^_From Kanban card `([0-9a-f-]{36})`/m;

/** The card a task file was written for, or null for a hand-written file. */
export const cardIdOf = (text) => CARD_ID.exec(text)?.[1] ?? null;

/**
 * What the agent wrote about its own run. `## Results` when it followed the skill;
 * otherwise everything past the requirement block, because agents do improvise the
 * headings (163 filed Investigation / Plan / Log / Status and no Results at all).
 */
export function resultsOf(text) {
  const results = /^##\s+Results\b.*$/im.exec(text);
  if (results) return text.slice(results.index).trim();
  const headings = [...text.matchAll(/^##\s+(.+)$/gm)];
  const after = headings.find(
    (h) => !/^original requirement$/i.test(h[1].trim()),
  );
  return after && after !== headings[0] ? text.slice(after.index).trim() : null;
}

/** `# Heading` from a task file, else the file's slug. */
export function titleOf(text, filename) {
  const m = /^#\s+(.+)$/m.exec(text);
  return m ? m[1].trim() : basename(filename, ".md");
}

/** POST a GraphQL op with the admin secret. Shared with `sessionUsage.js`. */
export async function gql(kanban, query, variables) {
  const res = await fetch(kanban.endpoint, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-hasura-admin-secret": kanban.adminSecret,
    },
    body: JSON.stringify({ query, variables }),
    signal: AbortSignal.timeout(15000),
  });
  const body = await res.json();
  if (body.errors)
    throw new Error(body.errors.map((e) => e.message).join("; "));
  return body.data;
}

// `boards.github` is a text column holding JSON, not jsonb — `_contains` is a
// runtime error on it, which is what the app's own GET_BOARD_BY_REPO still does.
export const BOARD = `query B($repo: String!) {
  boards(where: {github: {_ilike: $repo}}, limit: 1) {
    id user_id lists(order_by: {sort_order: asc}) { id name }
  }
}`;

// Every card filed for a path, oldest first: the first one in is the lock (followup.js,
// claim.js) and a racing runner drops its own.
export const CARDS_AT = `query A($path: String!) {
  todos(where: {task_file_path: {_eq: $path}}, order_by: [{created_at: asc}, {id: asc}]) { id }
}`;
export const NEW_CARD = `mutation N($o: todos_insert_input!) { insert_todos_one(object: $o) { id } }`;
export const DROP = `mutation D($id: uuid!) { delete_todos_by_pk(id: $id) { id } }`;

// The card ends where the task file ends: move it to Review and point it at the -DONE
// file. The Results go into a comment only — the card body stays the original request.
const MOVE = `mutation M($id: uuid!, $list: uuid!, $path: String!) {
  update_todos_by_pk(
    pk_columns: {id: $id}
    _set: {list_id: $list, task_file_path: $path}
  ) { id }
}`;

const SAY = `mutation S($id: uuid!, $user: uuid!, $body: String!) {
  insert_comments(objects: {todo_id: $id, user_id: $user, content: $body}) { affected_rows }
}`;

// A re-run must not re-post the same Results: the move is idempotent on its own,
// a comment is not.
const SAID = `query D($id: uuid!, $body: String!) {
  comments(where: {todo_id: {_eq: $id}, content: {_eq: $body}}, limit: 1) { id }
}`;

// Update only the file path — no list change. Used when the Review list does not
// exist yet: the card stays where it is but still links to the -DONE file.
const SET_PATH = `mutation P($id: uuid!, $path: String!) {
  update_todos_by_pk(
    pk_columns: {id: $id}
    _set: {task_file_path: $path}
  ) { id }
}`;

/** The `-DONE.md` — or `-BLOCKED.md` — this task ended as. Keyed by stem, because a
 * bare NNN can belong to two tasks and this file decides which card gets the Results. */
export function doneFile(dir, stem) {
  return readdirSync(dir).find(
    (n) => /-(DONE|BLOCKED)\.md$/i.test(n) && stemOf(n) === stem,
  );
}

/**
 * Move the card to Review with the agent's own Results as a comment. Follow-ups the
 * run split out are filed by the reconcile sweep (followup.js). Returns log lines.
 */
export async function closeLoop(
  kanban,
  { repoName, repoPath, dir, stem, blocked },
) {
  const full = join(repoPath, dir);
  const done = doneFile(full, stem);
  if (!done) return [];

  const text = readFileSync(join(full, done), "utf8");
  const body = resultsOf(text) ?? `Task complete — \`${dir}/${done}\``;

  // The issue is closed straight from here with `gh`, so it does not depend on the
  // Kanban being configured — nor on the push webhook, which was never registered.
  const out = await reportToIssue({ repoName, text, body, blocked });

  if (!kanban?.endpoint || !kanban?.adminSecret) return out;
  // A card the runner adopted for a card-less file (claim.js) is found by its path.
  const id =
    cardIdOf(text) ??
    (await gql(kanban, CARDS_AT_PATHS, { paths: [`${dir}/${stem}-TODO.md`] }))
      .todos[0]?.id;
  if (!id) return [...out, `no card id in ${done} — no card to close`];

  const { boards } = await gql(kanban, BOARD, { repo: `%${repoName}%` });
  const board = boards?.[0];
  if (!board) return [...out, `no board connected to ${repoName}`];
  const listId = (name) =>
    board.lists.find((l) => l.name.toLowerCase() === name.toLowerCase())?.id;

  // Always point the card at the -DONE file so it links to the outcome even if
  // the Review list does not exist yet (e.g. board was just created).
  const review = listId(kanban.lists.review);
  if (review) {
    await gql(kanban, MOVE, { id, list: review, path: `${dir}/${done}` });
  } else {
    await gql(kanban, SET_PATH, { id, path: `${dir}/${done}` });
    out.push(
      `no "${kanban.lists.review}" list — card path updated but not moved`,
    );
  }

  // Always post Results as a comment; idempotent so re-runs don't duplicate it.
  const { comments } = await gql(kanban, SAID, { id, body });
  if (comments.length)
    out.push(
      `${review ? `card → ${kanban.lists.review}` : "card"} (results already posted)`,
    );
  else {
    await gql(kanban, SAY, { id, user: board.user_id, body });
    out.push(
      review
        ? `card → ${kanban.lists.review}, results posted`
        : `results posted (card not moved — create a "${kanban.lists.review}" list)`,
    );
  }
  return out;
}

const CARDS = `query C($ids: [uuid!]!) {
  todos(where: {id: {_in: $ids}}) { id task_file_path list { name } }
}`;

const CARDS_AT_PATHS = `query P($paths: [String!]!) {
  todos(where: {task_file_path: {_in: $paths}}, order_by: [{created_at: asc}, {id: asc}]) {
    id task_file_path list { name }
  }
}`;

/**
 * Card id → its -DONE/-BLOCKED file, for every finished task file in `full`, and
 * the `-TODO` path → finished file for those that name no card.
 */
export function finishedCards(full, dir = "") {
  const byCard = new Map();
  const byPath = new Map();
  for (const n of readdirSync(full)) {
    if (!/-(DONE|BLOCKED)\.md$/i.test(n)) continue;
    const id = cardIdOf(readFileSync(join(full, n), "utf8"));
    if (id) byCard.set(id, n);
    else byPath.set(`${dir}/${stemOf(n)}-TODO.md`, n);
  }
  return { byCard, byPath };
}

/**
 * Cards in TODO or Doing that still point at the -TODO file of a finished task.
 * closeLoop repoints a card at its -DONE file, so a card a human moved back to
 * TODO for a redo points there and is left alone; so is anything in another list.
 */
export function stuckCards(todos, byCard, lists) {
  const open = new Set([lists.todo, lists.doing].map((l) => l.toLowerCase()));
  return todos
    .filter(
      (t) =>
        byCard.has(t.id) &&
        open.has(t.list?.name?.toLowerCase()) &&
        /-TODO\.md$/i.test(t.task_file_path ?? "") &&
        stemOf(basename(t.task_file_path)) === stemOf(byCard.get(t.id)),
    )
    .map((t) => byCard.get(t.id));
}

/**
 * closeLoop only runs at the end of the runner's own run, so a task finished any
 * other way kept its card in TODO for good: by hand after a park (tekdok 027), on
 * a run a runner restart orphaned (tekdok 034), or on a peer whose close step never
 * ran (tekdok 035). Close those from the file, whoever renamed it.
 */
export async function reconcileCards(kanban, { repoName, repoPath, dir }) {
  if (!kanban?.endpoint || !kanban?.adminSecret) return [];
  const { byCard, byPath } = finishedCards(join(repoPath, dir), dir);
  const todos = byCard.size
    ? (await gql(kanban, CARDS, { ids: [...byCard.keys()] })).todos
    : [];
  // Cards the runner adopted for card-less files (claim.js) still point at the -TODO.
  if (byPath.size)
    for (const t of (
      await gql(kanban, CARDS_AT_PATHS, { paths: [...byPath.keys()] })
    ).todos) {
      if (byCard.has(t.id)) continue;
      byCard.set(t.id, byPath.get(t.task_file_path));
      todos.push(t);
    }
  const out = [];
  for (const name of stuckCards(todos, byCard, kanban.lists)) {
    const lines = await closeLoop(kanban, {
      repoName,
      repoPath,
      dir,
      stem: stemOf(name),
      blocked: /-BLOCKED\.md$/i.test(name),
    });
    out.push(`${name}: ${lines.join("; ")}`);
  }
  return out;
}
