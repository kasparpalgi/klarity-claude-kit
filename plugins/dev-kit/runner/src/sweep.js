/**
 * Worktrees a run left behind (#91). A task's worktree normally goes when its run ends;
 * one stays while its pane still works, for the retry after a usage limit, or when its
 * work would not land. This puts away each one whose task is over — finished in the
 * tree or no longer queued, with no live pane — and the branches nothing uses any more.
 * Each worktree holds a full `node_modules`, so a forgotten one is hundreds of megabytes.
 */

import { basename, join } from "node:path";
import { landWorktree } from "./land.js";
import { commitTaskDir, dirtyPaths, git, parkDirty } from "./repo.js";
import { listPending, numberOf, retired } from "./queue.js";
import { closeWorktree, onOrigin, root } from "./worktree.js";

/** The runner's own worktrees of this clone, never one a person made elsewhere. */
export async function runnerTrees(repoPath) {
  const mine = join(root(), basename(repoPath)) + "/";
  const { stdout } = await git(["worktree", "list", "--porcelain"], repoPath);
  return stdout
    .split("\n\n")
    .map((b) => /^worktree (.+)$/m.exec(b)?.[1])
    .filter((p) => p?.startsWith(mine));
}

/** Branches swept once per process: after that, closing a tree drops its own. */
const swept = new Set();
/** Path → why its work would not land, said once rather than every tick. */
const kept = new Map();

/**
 * `live(pane)` says whether a herdr pane still works. Returns a line per change, and how
 * many trees landed commits: until the clone pulls them, their tasks still read as
 * queued, so the caller looks again next tick rather than run one twice. A pull
 * request repo's tree only goes when it is clean and all on origin; a push-to-main
 * repo's work is parked or landed first, so nothing is ever lost; the clone catches up
 * at the next preflight.
 */
export async function sweepWorktrees({ repoPath, dir, base, viaPr, live }) {
  const lines = [];
  let landed = 0;
  await git(["worktree", "prune"], repoPath);
  const pending = new Set(listPending(repoPath, dir).map((p) => p.stem));
  for (const path of await runnerTrees(repoPath)) {
    const stem = basename(path);
    if (pending.has(stem) && !retired(path, dir, stem)) continue;
    if (await live(`task-${numberOf(stem)}`)) continue;
    if (viaPr) {
      const lost =
        (await dirtyPaths(path)).length || !(await onOrigin("HEAD", path));
      if (!lost) {
        await closeWorktree(repoPath, path);
        lines.push(`removed the worktree of ${stem}`);
      }
      continue;
    }
    await commitTaskDir(path, dir, `docs(todo): ${stem} bookkeeping (runner)`);
    const parked = await parkDirty(path, `${stem} (sweep)`);
    const r = await landWorktree(repoPath, path, stem, base).catch((err) => ({
      error: err.stderr?.trim() || err.message,
    }));
    if (r.error) {
      if (kept.get(path) !== r.error)
        lines.push(`kept the worktree of ${stem}: ${r.error}`);
      kept.set(path, r.error);
      continue;
    }
    kept.delete(path);
    if (r.landed) landed++;
    lines.push(
      `removed the worktree of ${stem}${r.landed ? `, landed ${r.landed} commit(s) on ${base}` : ""}${r.branch ? `, its branch ${r.branch} pushed` : ""}${parked ? ", leftovers stashed" : ""}`,
    );
  }
  if (!swept.has(repoPath)) {
    swept.add(repoPath);
    const n = await dropBranches(repoPath);
    if (n)
      lines.push(
        `deleted ${n} local run/ and todo/ branch(es) already on origin`,
      );
  }
  return { lines, landed };
}

/** Local `run/*` and `todo/*` branches whose commits are all on origin. */
async function dropBranches(repoPath) {
  const { stdout } = await git(
    ["branch", "--format=%(refname:short)", "--list", "run/*", "todo/*"],
    repoPath,
  );
  let n = 0;
  for (const b of stdout.split("\n").filter(Boolean))
    if (
      (await onOrigin(`refs/heads/${b}`, repoPath)) &&
      // Refused while a worktree has it checked out: that one is still in use.
      (await git(["branch", "-D", b], repoPath).then(
        () => true,
        () => false,
      ))
    )
      n++;
  return n;
}
