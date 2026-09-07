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

// The exact marker buildTaskFile() writes, anchored to the start of its own line:
// a follow-up file quotes its parent as "(from Kanban card `…`)" and must not match.
const CARD_ID = /^_From Kanban card `([0-9a-f-]{36})`/m;
const FOLLOW_UP = /^\d{3,}-.*(?<!-TODO)(?<!-DONE)(?<!-BLOCKED)\.md$/i;

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

const esc = (s) =>
  s.replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" })[c]);

/**
 * The card body is editor HTML; Results are markdown. Enough of a conversion to read
 * well on the card — headings, bullets, bold, code. Anything richer belongs in the file.
 */
export function toHtml(md) {
  const inline = (s) =>
    esc(s)
      .replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>")
      .replace(/`(.+?)`/g, "<code>$1</code>");

  const out = [];
  let list = null;
  let para = null;
  const flush = () => {
    if (list) out.push(`<ul>${list.join("")}</ul>`);
    if (para) out.push(`<p>${para.join("<br>")}</p>`);
    list = para = null;
  };

  for (const line of md.trim().split("\n")) {
    const heading = /^#{1,6}\s+(.*)$/.exec(line);
    const bullet = /^\s*[-*]\s+(.*)$/.exec(line);
    if (!line.trim()) flush();
    else if (heading) {
      flush();
      out.push(`<h3>${inline(heading[1])}</h3>`);
    } else if (bullet) {
      if (para) flush();
      (list ??= []).push(`<li>${inline(bullet[1])}</li>`);
    } else {
      if (list) flush();
      (para ??= []).push(inline(line));
    }
  }
  flush();
  return out.join("");
}

// The card's own report, appended the same way the task file appends `## Results`.
// A re-run replaces it from this heading on — two runs must not stack two reports.
const RESULTS_H = "<h3>Results</h3>";

export function withResults(content, results) {
  const kept = (content ?? "").split(RESULTS_H)[0].replace(/\s+$/, "");
  return kept + RESULTS_H + toHtml(results.replace(/^##\s+Results\s*/i, ""));
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

// The card ends where the task file ends: same list move, same Results appended to the
// body. `content` is the card's HTML body, not a comment — comments are the running log.
const MOVE = `mutation M($id: uuid!, $list: uuid!, $path: String!, $content: String!) {
  update_todos_by_pk(
    pk_columns: {id: $id}
    _set: {list_id: $list, task_file_path: $path, content: $content}
  ) { id }
}`;

const CARD = `query C($id: uuid!) { todos_by_pk(id: $id) { content } }`;

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

/** The `NNN-*-DONE.md` — or `-BLOCKED.md` — this task number ended as. */
function doneFile(dir, number) {
  return readdirSync(dir).find((n) =>
    new RegExp(`^${number}-.*-(DONE|BLOCKED)\\.md$`, "i").test(n),
  );
}

/**
 * Move the card to Review with the agent's own Results as a comment, and file any
 * follow-up task file the run added as a Backlog card. Returns log lines.
 */
export async function closeLoop(
  kanban,
  { repoName, repoPath, dir, number, added, blocked },
) {
  const full = join(repoPath, dir);
  const done = doneFile(full, number);
  if (!done) return [];

  const text = readFileSync(join(full, done), "utf8");
  const body = resultsOf(text) ?? `Task complete — \`${dir}/${done}\``;

  // The issue is closed straight from here with `gh`, so it does not depend on the
  // Kanban being configured — nor on the push webhook, which was never registered.
  const out = await reportToIssue({ repoName, text, body, blocked });

  if (!kanban?.endpoint || !kanban?.adminSecret) return out;
  const id = cardIdOf(text);
  if (!id) return [...out, `no card id in ${done} — no card to close`];

  const { boards } = await gql(kanban, BOARD, { repo: `%${repoName}%` });
  const board = boards?.[0];
  if (!board) return [...out, `no board connected to ${repoName}`];
  const listId = (name) =>
    board.lists.find((l) => l.name.toLowerCase() === name.toLowerCase())?.id;

  const review = listId(kanban.lists.review);
  if (review) {
    // The card body gets the Results the same way the task file did, so the card and
    // the markdown say the same thing without opening the repo.
    const { todos_by_pk: card } = await gql(kanban, CARD, { id });
    await gql(kanban, MOVE, {
      id,
      list: review,
      path: `${dir}/${done}`,
      content: withResults(card?.content, body),
    });
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
