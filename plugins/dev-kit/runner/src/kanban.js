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

// The exact marker buildTaskFile() writes, anchored to the start of its own line:
// a follow-up file quotes its parent as "(from Kanban card `…`)" and must not match.
const CARD_ID = /^_From Kanban card `([0-9a-f-]{36})`/m;
const FOLLOW_UP = /^(\d{3})-.*(?<!-TODO)(?<!-DONE)\.md$/i;

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
  const after = headings.find((h) => !/^original requirement$/i.test(h[1].trim()));
  return after && after !== headings[0] ? text.slice(after.index).trim() : null;
}

/** `# Heading` from a task file, else the file's slug. */
export function titleOf(text, filename) {
  const m = /^#\s+(.+)$/m.exec(text);
  return m ? m[1].trim() : basename(filename, ".md");
}

async function gql(kanban, query, variables) {
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
const BOARD = `query B($repo: String!) {
  boards(where: {github: {_ilike: $repo}}, limit: 1) {
    id user_id lists(order_by: {sort_order: asc}) { id name }
  }
}`;

const MOVE = `mutation M($id: uuid!, $list: uuid!, $path: String!) {
  update_todos_by_pk(pk_columns: {id: $id}, _set: {list_id: $list, task_file_path: $path}) { id }
}`;

const SAY = `mutation S($id: uuid!, $user: uuid!, $body: String!) {
  insert_comments(objects: {todo_id: $id, user_id: $user, content: $body}) { affected_rows }
}`;

// A re-run must not re-post the same Results: the move is idempotent on its own,
// a comment is not.
const SAID = `query D($id: uuid!, $body: String!) {
  comments(where: {todo_id: {_eq: $id}, content: {_eq: $body}}, limit: 1) { id }
}`;

const NEW_CARD = `mutation N($o: [todos_insert_input!]!) {
  insert_todos(objects: $o) { returning { id title } }
}`;

const EXISTING = `query E($paths: [String!]!) {
  todos(where: {task_file_path: {_in: $paths}}) { task_file_path }
}`;

/** Newest `NNN-*-DONE.md` for this task number. */
function doneFile(dir, number) {
  return readdirSync(dir).find((n) =>
    new RegExp(`^${number}-.*-DONE\\.md$`, "i").test(n),
  );
}

/**
 * Move the card to Review with the agent's own Results as a comment, and file any
 * follow-up task file the run added as a Backlog card. Returns log lines.
 */
export async function closeLoop(
  kanban,
  { repoName, repoPath, dir, number, added },
) {
  if (!kanban?.endpoint || !kanban?.adminSecret) return [];
  const full = join(repoPath, dir);
  const done = doneFile(full, number);
  if (!done) return [];

  const text = readFileSync(join(full, done), "utf8");
  const id = cardIdOf(text);
  if (!id) return [`no card id in ${done} — nothing to close`];

  const { boards } = await gql(kanban, BOARD, { repo: `%${repoName}%` });
  const board = boards?.[0];
  if (!board) return [`no board connected to ${repoName}`];
  const listId = (name) =>
    board.lists.find((l) => l.name.toLowerCase() === name.toLowerCase())?.id;

  const out = [];
  const review = listId(kanban.lists.review);
  if (review) {
    await gql(kanban, MOVE, { id, list: review, path: `${dir}/${done}` });
    const body = resultsOf(text) ?? `Task complete — \`${dir}/${done}\``;
    const { comments } = await gql(kanban, SAID, { id, body });
    if (comments.length) out.push(`card → ${kanban.lists.review} (results already posted)`);
    else {
      await gql(kanban, SAY, { id, user: board.user_id, body });
      out.push(`card → ${kanban.lists.review}, results posted`);
    }
  } else out.push(`no "${kanban.lists.review}" list on the board`);

  out.push(
    ...(await fileFollowUps(kanban, { board, listId, full, dir, added })),
  );
  return out;
}

/** A new NNN-*.md with no card of its own is a follow-up the agent split out. */
async function fileFollowUps(kanban, { board, listId, full, dir, added }) {
  const backlog = listId(kanban.lists.backlog);
  const files = added
    .filter((f) => f.startsWith(`${dir}/`) && FOLLOW_UP.test(basename(f)))
    .filter((f) => !cardIdOf(readFileSync(join(full, basename(f)), "utf8")));
  if (!files.length) return [];
  if (!backlog)
    return [
      `no "${kanban.lists.backlog}" list — ${files.length} follow-up(s) unfiled`,
    ];

  const { todos } = await gql(kanban, EXISTING, { paths: files });
  const taken = new Set(todos.map((t) => t.task_file_path));
  const objects = files
    .filter((f) => !taken.has(f))
    .map((f) => {
      const text = readFileSync(join(full, basename(f)), "utf8");
      return {
        title: titleOf(text, f),
        content: text,
        list_id: backlog,
        user_id: board.user_id,
        task_file_path: f,
      };
    });
  if (!objects.length) return [];

  const { insert_todos } = await gql(kanban, NEW_CARD, { o: objects });
  return insert_todos.returning.map(
    (t) => `follow-up → ${kanban.lists.backlog}: ${t.title}`,
  );
}
