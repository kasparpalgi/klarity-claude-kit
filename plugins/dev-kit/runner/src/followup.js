/**
 * File every follow-up task file as a GitHub issue first, then a Kanban Backlog card,
 * and number the file by its issue (svelte-hasura-boilerplate#53).
 *
 * This used to run only at the end of the runner's own run, on what that run committed,
 * and it made a card but never an issue. A follow-up committed any other way — a pane
 * still working after the runner gave up on it (043 → 046), a session at a desk — was
 * never filed at all. Now the reconcile sweep calls it for every new HEAD, whoever made
 * the commit. Every runner sweeps the same commits, so the card is the lock: the first
 * card in for a path wins, and a runner that loses removes its own and stops.
 */

import { execFile } from "node:child_process";
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { promisify } from "node:util";
import { BOARD, cardIdOf, gql, titleOf } from "./kanban.js";
import { issueOf } from "./issue.js";
import { numberOf } from "./queue.js";
import { git } from "./repo.js";

const run = promisify(execFile);

// Suffixless: -TODO is queued work, -DONE / -BLOCKED are finished.
const FOLLOW_UP = /^\d{3,}-.*(?<!-TODO)(?<!-DONE)(?<!-BLOCKED)\.md$/i;

const CARDS_AT = `query A($path: String!) {
  todos(where: {task_file_path: {_eq: $path}}, order_by: [{created_at: asc}, {id: asc}]) { id }
}`;
const NEW_CARD = `mutation N($o: todos_insert_input!) { insert_todos_one(object: $o) { id } }`;
const DROP = `mutation D($id: uuid!) { delete_todos_by_pk(id: $id) { id } }`;
const FILED = `mutation F($id: uuid!, $set: todos_set_input!) {
  update_todos_by_pk(pk_columns: {id: $id}, _set: $set) { id }
}`;

/** The same line the Kanban writes; issue.js closes the issue from it when the task ends. */
export const withIssue = (text, n) =>
  issueOf(text)
    ? text
    : `${text.trimEnd()}\n\n_GitHub issue #${n} — end the commit subject with \`(#${n})\`._\n`;

/**
 * `054-x.md` filed as #57 becomes `057-x.md` — unless something else already holds 057;
 * then it keeps its name and the Kanban takes the number when the card reaches TODO.
 */
export function issueName(name, n, names) {
  const taken = names.some((x) => x !== name && Number(numberOf(x)) === n);
  return taken
    ? name
    : `${String(n).padStart(3, "0")}-${name.replace(/^\d+-/, "")}`;
}

/** The issue the agent already opened (its line is in the file), else a new one. */
async function ensureIssue(repoName, text, title) {
  const n = issueOf(text);
  const args = n
    ? ["api", `repos/${repoName}/issues/${n}`]
    : [
        "api",
        `repos/${repoName}/issues`,
        "-X",
        "POST",
        "-f",
        `title=${title}`,
        "-f",
        `body=${text}`,
      ];
  const { stdout } = await run("gh", args, { timeout: 30_000 });
  return JSON.parse(stdout);
}

async function fileOne(kanban, { repoName, repoPath, dir, board, backlog }, f) {
  const text = readFileSync(join(repoPath, f), "utf8");
  if ((await gql(kanban, CARDS_AT, { path: f })).todos.length) return null;

  const title = titleOf(text, f);
  const { insert_todos_one: card } = await gql(kanban, NEW_CARD, {
    o: {
      title,
      content: text,
      list_id: backlog,
      user_id: board.user_id,
      task_file_path: f,
    },
  });
  if ((await gql(kanban, CARDS_AT, { path: f })).todos[0]?.id !== card.id) {
    await gql(kanban, DROP, { id: card.id });
    return null;
  }

  const issue = await ensureIssue(repoName, text, title);
  const name = issueName(
    basename(f),
    issue.number,
    readdirSync(join(repoPath, dir)),
  );
  const path = `${dir}/${name}`;
  const body = withIssue(text, issue.number);
  writeFileSync(join(repoPath, f), body);
  if (path !== f) await git(["mv", f, path], repoPath);
  await git(["add", "--", path], repoPath);
  await git(
    ["commit", "-m", `docs(todo): file follow-up ${name} as #${issue.number}`],
    repoPath,
  );
  const pushed = await git(["push", "origin", "HEAD"], repoPath).then(
    () => true,
    () => false,
  );

  await gql(kanban, FILED, {
    id: card.id,
    set: {
      task_file_path: path,
      content: body,
      github_issue_number: issue.number,
      github_issue_id: issue.id,
      github_url: issue.html_url,
      github_synced_at: new Date().toISOString(),
    },
  });
  return `follow-up ${name} → issue #${issue.number}, ${kanban.lists.backlog}${pushed ? "" : " (push failed — committed locally)"}`;
}

/** File the follow-ups added between `since` and HEAD. Returns log lines. */
export async function fileFollowUps(
  kanban,
  { repoName, repoPath, dir, since },
) {
  if (!kanban?.endpoint || !kanban?.adminSecret) return [];
  const { stdout } = await git(
    ["diff", "--name-only", "--diff-filter=A", `${since}..HEAD`, "--", dir],
    repoPath,
  );
  const files = stdout
    .split("\n")
    .filter((f) => dirname(f) === dir && FOLLOW_UP.test(basename(f)))
    .filter((f) => existsSync(join(repoPath, f)))
    .filter((f) => !cardIdOf(readFileSync(join(repoPath, f), "utf8")));
  if (!files.length) return [];

  // Only a board connected to this repo files issues — the repos that already use
  // the issue-number-is-task-number convention.
  const board = (await gql(kanban, BOARD, { repo: `%${repoName}%` }))
    .boards?.[0];
  if (!board) return [];
  const want = kanban.lists.backlog.toLowerCase();
  const backlog = board.lists.find((l) => l.name.toLowerCase() === want)?.id;
  if (!backlog)
    return [
      `no "${kanban.lists.backlog}" list — ${files.length} follow-up(s) unfiled`,
    ];

  const out = [];
  for (const f of files) {
    const line = await fileOne(
      kanban,
      { repoName, repoPath, dir, board, backlog },
      f,
    ).catch((err) => `${basename(f)}: ${err.stderr?.trim() || err.message}`);
    if (line) out.push(line);
  }
  return out;
}
