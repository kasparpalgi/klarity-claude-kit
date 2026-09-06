/**
 * Git preflight. The runner's job is to arrive at "clean tree, on the base
 * branch, up to date" — or to say precisely why it could not, once.
 */

import { execFile } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { promisify } from "node:util";

const exec = promisify(execFile);
export const git = (args, cwd) => exec("git", args, { cwd });
const out = async (args, cwd) => (await git(args, cwd)).stdout.trim();
const ok = (args, cwd) => git(args, cwd).then(() => true, () => false);

/** Paths from `git status --porcelain`, rename targets included. */
export async function dirtyPaths(cwd) {
  // No trim(): the status prefix is exactly 3 columns, leading space included.
  const { stdout } = await git(["status", "--porcelain"], cwd);
  return stdout
    .split("\n")
    .filter(Boolean)
    .map((l) => l.slice(3).split(" -> ").pop().replace(/^"|"$/g, ""));
}

/** origin's default branch; `main` when the remote never told us. */
export async function baseBranch(cwd) {
  try {
    const ref = await out(
      ["symbolic-ref", "--short", "refs/remotes/origin/HEAD"],
      cwd,
    );
    return ref.replace(/^origin\//, "");
  } catch {
    return "main";
  }
}

/**
 * Keep agent logs out of git so they never dirty the tree — and commit the
 * rule itself, or the untracked .gitignore would dirty it instead.
 */
export async function ignoreLogs(dir, cwd) {
  const file = join(dir, ".gitignore");
  const cur = existsSync(file) ? readFileSync(file, "utf8") : "";
  if (cur.includes("*.log")) return;
  writeFileSync(file, cur + "*.log\n");
  await git(["add", file], cwd);
  await git(["commit", "-m", "chore: ignore runner task logs", file], cwd);
}

/**
 * Returns `{ reason }` when the repo must be skipped, otherwise `{ notes,
 * handoff }`. `handoff` names a task number whose work was left on a branch:
 * it has been pushed, so the runner must not run that number again.
 */
export async function preflight(cwd, taskDir) {
  const dirty = await dirtyPaths(cwd);
  if (dirty.length && dirty.every((p) => p.startsWith(taskDir + "/"))) {
    await git(["add", "-A", "--", taskDir], cwd);
    await git(
      ["commit", "-m", "chore(todo): checkpoint uncommitted agent output"],
      cwd,
    );
  } else if (dirty.length) {
    return { reason: `dirty working tree — ${dirty.slice(0, 6).join(", ")}` };
  }

  if (!(await ok(["fetch", "origin"], cwd)))
    return { reason: "cannot reach origin (fetch failed)" };

  const base = await baseBranch(cwd);
  const branch = await out(["branch", "--show-current"], cwd);
  if (!branch)
    return { reason: `detached HEAD at ${await out(["rev-parse", "--short", "HEAD"], cwd)}` };

  const notes = [];
  let handoff;
  if (branch !== base) {
    const ahead = Number(
      await out(["rev-list", "--count", `origin/${base}..HEAD`], cwd).catch(
        () => "0",
      ),
    );
    if (ahead && !(await ok(["push", "-u", "origin", "HEAD"], cwd)))
      return { reason: `on branch ${branch} with ${ahead} unpushed commit(s) that will not push` };
    if (ahead) notes.push(`pushed ${branch} (${ahead} commit(s)) — merge it into ${base}`);
    if (!(await ok(["checkout", base], cwd)))
      return { reason: `cannot leave branch ${branch} for ${base}` };
    notes.push(`switched ${branch} → ${base}`);
    const n = /^(\d{3})-/.exec(branch);
    if (ahead && n) handoff = n[1];
  }

  if (!(await ok(["pull", "--ff-only"], cwd)))
    return { reason: `${base} has diverged from origin/${base} (pull --ff-only failed)` };

  return { notes, handoff };
}
