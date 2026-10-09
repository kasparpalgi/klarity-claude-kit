/**
 * A pull request repo's task runs on its own branch, `todo/<stem>`, in its own
 * worktree — never in the clone the runner keeps on the base branch, and never in a
 * tree another session shares. When the session ends, what it left is committed to
 * that branch, pushed, and carried by a pull request: the base branch only ever gets
 * code through a merge.
 */

import { execFile } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join } from "node:path";
import { promisify } from "node:util";
import { dirtyPaths, git } from "./repo.js";
import { secretsOf } from "./secrets.js";

const run = promisify(execFile);
const out = async (args, cwd) => (await git(args, cwd)).stdout.trim();
const ok = (args, cwd) =>
  git(args, cwd).then(
    () => true,
    () => false,
  );
const gh = async (args, cwd) =>
  (await run("gh", args, { cwd, timeout: 60_000 })).stdout.trim();

export const branchOf = (stem) => `todo/${stem}`;

const root = () =>
  process.env.KANBAN_RUNNER_WORKTREES ??
  join(homedir(), ".kanban-runner", "worktrees");

export const worktreeOf = (repoPath, stem) =>
  join(root(), basename(repoPath), stem);

/**
 * The task's worktree, made on first use: on `origin/todo/<stem>` when an earlier
 * attempt pushed one, else on a fresh `origin/<base>` — or on the local branch when it
 * already holds that and more, such as bookkeeping that did not land. One left by an
 * attempt that hit the usage limit is reused as it is. A new tree gets the clone's gitignored secrets
 * and, with a lockfile, `npm ci` — a session cannot test without either.
 */
export async function openWorktree(repoPath, stem, base, log = () => {}) {
  const path = worktreeOf(repoPath, stem);
  if (existsSync(join(path, ".git"))) return path;
  const branch = branchOf(stem);
  await git(["worktree", "prune"], repoPath);
  await git(["fetch", "--prune", "origin"], repoPath);
  const pushed = await ok(
    ["rev-parse", "--verify", "-q", `refs/remotes/origin/${branch}`],
    repoPath,
  );
  const start = pushed ? `origin/${branch}` : `origin/${base}`;
  const keep = await ok(
    ["merge-base", "--is-ancestor", start, `refs/heads/${branch}`],
    repoPath,
  );
  mkdirSync(dirname(path), { recursive: true });
  rmSync(path, { recursive: true, force: true });
  await git(
    keep
      ? ["worktree", "add", path, branch]
      : ["worktree", "add", "--no-track", "-B", branch, path, start],
    repoPath,
  );
  for (const f of Object.keys(await secretsOf(repoPath))) {
    mkdirSync(dirname(join(path, f)), { recursive: true });
    copyFileSync(join(repoPath, f), join(path, f));
  }
  if (existsSync(join(path, "package-lock.json")))
    await run("npm", ["ci", "--prefer-offline", "--no-audit", "--no-fund"], {
      cwd: path,
      timeout: 15 * 60_000,
      maxBuffer: 1 << 26,
    }).catch((err) =>
      log(`  npm ci failed in the worktree: ${err.message.split("\n")[0]}`),
    );
  log(
    `  worktree ${path} on ${branch}${pushed ? " (continuing its pushed branch)" : ""}`,
  );
  return path;
}

export async function closeWorktree(repoPath, path) {
  if (!(await ok(["worktree", "remove", "--force", path], repoPath)))
    rmSync(path, { recursive: true, force: true });
  await git(["worktree", "prune"], repoPath);
}

/** The open PR for `branch`, or null. */
async function openPr(repoName, branch, cwd) {
  const list = JSON.parse(
    await gh(
      [
        "pr",
        "list",
        "--repo",
        repoName,
        "--head",
        branch,
        "--state",
        "open",
        "--json",
        "number,isDraft,url,title,headRefName",
      ],
      cwd,
    ),
  );
  return list[0] ?? null;
}

/**
 * Put a session that ended off any branch back on the task's. Refuses when that would
 * drop the branch's own commits, or ship commits that belong to another branch.
 */
async function backOnBranch(path, branch, base) {
  const local = await ok(
    ["rev-parse", "--verify", "-q", `refs/heads/${branch}`],
    path,
  );
  if (
    local &&
    !(await ok(["merge-base", "--is-ancestor", branch, "HEAD"], path))
  )
    throw new Error(
      `the session left HEAD off ${branch}, at commits that do not contain it`,
    );
  const count = async (...not) =>
    out(["rev-list", "--count", "HEAD", "--not", ...not], path);
  const pushed = await ok(
    ["rev-parse", "--verify", "-q", `refs/remotes/origin/${branch}`],
    path,
  );
  const ours = await count(
    `origin/${base}`,
    ...(pushed ? [`origin/${branch}`] : []),
  );
  const others = await count(`--exclude=origin/${branch}`, "--remotes=origin");
  if (ours !== others)
    throw new Error(
      `the session left HEAD on another branch's commits, not on ${branch}`,
    );
  await git(["switch", "-C", branch], path);
}

/**
 * Ship what a session left in its worktree. Leftovers become a commit on the branch;
 * a detached HEAD gets the task's branch. A failed run passes `bookkeeping: false`:
 * whatever it wrote goes to a PR, not straight to the base. Returns one of
 *   { ahead: 0 }                 nothing on the branch — the session changed nothing
 *   { bookkeeping: sha, branch } only the task folder changed; it may go to the base
 *   { pr, url, opened, leftover, branch, undone }
 * where `undone` is the ready PR turned back into a draft, which needs a new review,
 * and throws when the branch will not push.
 */
export async function shipBranch({
  repoName,
  path,
  stem,
  base,
  dir,
  title,
  issue,
  bookkeeping = true,
}) {
  let branch = await out(["branch", "--show-current"], path);
  if (!branch || branch === base) {
    branch = branchOf(stem);
    await backOnBranch(path, branch, base);
  }
  const dirty = await dirtyPaths(path);
  const leftover = dirty.length > 0;
  if (leftover) {
    await git(["add", "-A"], path);
    await git(
      [
        "commit",
        "--no-verify",
        "-m",
        `wip(todo): what the ${stem} session left uncommitted${issue ? ` (#${issue})` : ""}`,
      ],
      path,
    );
  }
  const ahead = Number(
    await out(["rev-list", "--count", `origin/${base}..HEAD`], path),
  );
  if (!ahead) return { ahead: 0, branch };

  const existing = await openPr(repoName, branch, path);
  const changed = (
    await out(["diff", "--name-only", `origin/${base}...HEAD`], path)
  )
    .split("\n")
    .filter(Boolean);
  if (bookkeeping && !existing && changed.every((f) => f.startsWith(`${dir}/`)))
    return { bookkeeping: await out(["rev-parse", "HEAD"], path), branch };

  await git(["push", "-u", "origin", `HEAD:refs/heads/${branch}`], path);
  if (existing) {
    // Uncommitted work never merged unreviewed: back to draft, which waits for review.
    // The task folder alone is bookkeeping, such as a review session's own rename.
    const undone =
      !existing.isDraft && dirty.some((f) => !f.startsWith(`${dir}/`));
    if (undone) {
      await gh(
        ["pr", "ready", String(existing.number), "--undo", "--repo", repoName],
        path,
      );
      await gh(
        [
          "pr",
          "comment",
          String(existing.number),
          "--repo",
          repoName,
          "--body",
          "The runner committed work this session left uncommitted and turned the PR back into a draft: it needs a review before it merges.",
        ],
        path,
      );
    }
    return {
      pr: existing.number,
      url: existing.url,
      opened: false,
      leftover,
      branch,
      undone: undone ? existing : null,
    };
  }
  const body = [
    `The runner opened this draft for \`${dir}/${stem}-TODO.md\`: the session ended without a pull request of its own${leftover ? " and left work uncommitted, now the last commit" : ""}. A review session finishes it and marks it ready.`,
    issue ? `\nCloses #${issue}` : "",
  ].join("\n");
  const url = await gh(
    [
      "pr",
      "create",
      "--repo",
      repoName,
      "--draft",
      "--base",
      base,
      "--head",
      branch,
      "--title",
      `${title}${issue ? ` (#${issue})` : ""}`,
      "--body",
      body,
    ],
    path,
  );
  return {
    pr: Number(/\/pull\/(\d+)/.exec(url)?.[1]),
    url,
    opened: true,
    leftover,
    branch,
  };
}

/**
 * Bring a branch that only touched the task folder onto the base branch: task
 * bookkeeping is the one thing that may land there directly. Returns false when the
 * patch no longer applies, and the caller falls back to a pull request.
 */
export async function landBookkeeping(repoPath, sha, dir, base) {
  const { stdout: patch } = await git(
    ["diff", "--binary", `origin/${base}...${sha}`, "--", dir],
    repoPath,
  );
  try {
    await new Promise((resolve, reject) => {
      const child = execFile(
        "git",
        ["apply", "--3way", "--index"],
        { cwd: repoPath },
        (err) => (err ? reject(err) : resolve()),
      );
      child.stdin.end(patch);
    });
  } catch {
    await git(["reset", "--hard", "HEAD"], repoPath);
    return false;
  }
  const subject = await out(["log", "-1", "--format=%s", sha], repoPath);
  const message = /^docs\(todo\)/.test(subject)
    ? subject
    : `docs(todo): what the session wrote in its task file (runner)`;
  await git(["commit", "-m", message], repoPath);
  return true;
}
