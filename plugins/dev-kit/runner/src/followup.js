/**
 * File every follow-up task file as a GitHub issue first, then a Kanban Backlog card,
 * and number the file by its issue (svelte-hasura-boilerplate#53).
 *
 * The reconcile sweep calls it for every new HEAD, whoever made the commit. Every runner
 * sweeps the same commits, so the card is the lock: the first card in for a path wins.
 * The winner moves the card to the new name only once the rename is on origin — moved
 * after a failed push, it freed the path, a second runner filed the file again, and the
 * two renames left the first clone diverged for three days (klarity-claude-kit#2).
 */

import { execFile } from "node:child_process";
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { promisify } from "node:util";
import {
  boardOf,
  cardIdOf,
  cardsAt,
  hasKanban,
  runnerApi,
  titleOf,
} from "./kanban.js";
import { issueOf } from "./issue.js";
import { numberOf } from "./queue.js";
import { git } from "./repo.js";

const run = promisify(execFile);

// Suffixless: -TODO is queued work, -DONE / -BLOCKED are finished.
const FOLLOW_UP = /^\d{3,}-.*(?<!-TODO)(?<!-DONE)(?<!-BLOCKED)\.md$/i;

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

/** Gone from origin since we forked? The runner that won it renamed it there first. */
async function movedOnOrigin(repoPath, f) {
  await git(["fetch", "origin"], repoPath).catch(() => {});
  const diff = "diff --no-renames --name-only --diff-filter=D HEAD...@{u} --";
  const { stdout } = await git([...diff.split(" "), f], repoPath).catch(() => ({
    stdout: "",
  }));
  return stdout.trim() !== "";
}

/** Push, replaying onto origin once if it moved; a commit that still will not go is undone. */
async function push(repoPath) {
  const ok = (cmd) => git(cmd.split(" "), repoPath).then(Boolean, () => false);
  if (await ok("push origin HEAD")) return true;
  if ((await ok("pull --rebase")) && (await ok("push origin HEAD")))
    return true;
  await ok("rebase --abort");
  await git(["reset", "--keep", "HEAD~1"], repoPath);
  return false;
}

async function fileOne(kanban, { repoName, repoPath, dir, board, backlog }, f) {
  const text = readFileSync(join(repoPath, f), "utf8");
  if ((await cardsAt(kanban, f)).length) return null;

  const title = titleOf(text, f);
  const card = await runnerApi(kanban, "createCard", {
    title,
    content: text,
    list_id: backlog,
    user_id: board.user_id,
    task_file_path: f,
  });
  if ((await cardsAt(kanban, f))[0]?.id !== card.id) {
    await runnerApi(kanban, "deleteCard", { id: card.id });
    return null;
  }
  if (await movedOnOrigin(repoPath, f)) {
    await runnerApi(kanban, "deleteCard", { id: card.id });
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
  const pushed = await push(repoPath);

  await runnerApi(kanban, "updateCard", {
    id: card.id,
    set: {
      ...(pushed && { task_file_path: path, content: body }),
      github_issue_number: issue.number,
      github_issue_id: issue.id,
      github_url: issue.html_url,
      github_synced_at: new Date().toISOString(),
    },
  });
  return pushed
    ? `follow-up ${name} → issue #${issue.number}, ${kanban.lists.backlog}`
    : `follow-up ${basename(f)} → issue #${issue.number}, ${kanban.lists.backlog} (push failed — left unrenamed, the card keeps ${f})`;
}

/** File the follow-ups added between `since` and HEAD. Returns log lines. */
export async function fileFollowUps(
  kanban,
  { repoName, repoPath, dir, since },
) {
  if (!hasKanban(kanban)) return [];
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
  const board = await boardOf(kanban, repoName);
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
