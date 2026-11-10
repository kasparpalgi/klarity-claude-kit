/**
 * A push-to-main repo's task runs in a worktree too (#91), so no agent ever touches the
 * clone: a run that ends dirty, on another branch or half-rebased leaves that mess in
 * its own tree, and the next task in the repo starts regardless. What the run committed
 * is landed on the base branch from the worktree, then the clone fast-forwards to it.
 */

import { git } from "./repo.js";
import { closeWorktree, runBranchOf } from "./worktree.js";

const out = async (args, cwd) => (await git(args, cwd)).stdout.trim();
const ok = (args, cwd) =>
  git(args, cwd).then(
    () => true,
    () => false,
  );

/**
 * Push what the run committed and did not push onto origin's base branch — rebased when
 * origin moved on, as preflight does — and remove the worktree. The caller parks any
 * dirt first: a rebase needs a clean tree. Returns
 *   { landed: n }  n commits pushed (0 when the session pushed them itself)
 *   { branch }     the session moved to a branch of its own (its CLAUDE.md said so):
 *                  pushed there, never landed on the base
 *   { error }      it would not land; the worktree stays, holding the work
 */
export async function landWorktree(repoPath, path, stem, base) {
  const branch = await out(["branch", "--show-current"], path);
  if (branch && branch !== runBranchOf(stem)) {
    if (!(await ok(["push", "-u", "origin", "HEAD"], path)))
      return { error: `branch ${branch} will not push` };
    await closeWorktree(repoPath, path);
    return { branch };
  }
  let landed = 0;
  // Three goes: the Kanban pushes task files to origin all day.
  for (let i = 0; ; i++) {
    if (!(await ok(["fetch", "origin"], path)))
      return { error: "cannot reach origin" };
    landed = Number(
      await out(["rev-list", "--count", `origin/${base}..HEAD`], path),
    );
    if (!landed) break;
    // Only when origin moved on: a rebase would also flatten the agent's own merges.
    const behind = !(await ok(
      ["merge-base", "--is-ancestor", `origin/${base}`, "HEAD"],
      path,
    ));
    if (behind && !(await ok(["rebase", `origin/${base}`], path))) {
      await ok(["rebase", "--abort"], path);
      return { error: `it does not rebase onto origin/${base}` };
    }
    if (await ok(["push", "origin", `HEAD:refs/heads/${base}`], path)) break;
    if (i === 2) return { error: `origin refused the push to ${base}` };
  }
  await closeWorktree(repoPath, path);
  return { landed };
}

/**
 * Bring the clone up to origin's base after a landing: a fast-forward, or a rebase of
 * the runner's own unpushed commits (a rebased landing carried them already, so git
 * drops them). False when a person has the clone dirty or on another branch.
 */
export async function catchUp(repoPath, base) {
  if ((await out(["branch", "--show-current"], repoPath)) !== base)
    return false;
  if (await ok(["merge", "--ff-only", "-q", `origin/${base}`], repoPath))
    return true;
  if (await ok(["rebase", `origin/${base}`], repoPath)) return true;
  await ok(["rebase", "--abort"], repoPath);
  return false;
}
