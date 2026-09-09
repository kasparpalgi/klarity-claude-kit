/**
 * Git preflight. The runner's job is to arrive at "clean tree, on the base
 * branch, up to date" — or to say precisely why it could not, once.
 */

import { execFile } from "node:child_process";
import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { promisify } from "node:util";

const exec = promisify(execFile);
export const git = (args, cwd) => exec("git", args, { cwd });
const out = async (args, cwd) => (await git(args, cwd)).stdout.trim();
const ok = (args, cwd) =>
  git(args, cwd).then(
    () => true,
    () => false,
  );

/** Paths from `git status --porcelain`, rename targets included. */
export async function dirtyPaths(cwd) {
  // No trim(): the status prefix is exactly 3 columns, leading space included.
  const { stdout } = await git(["status", "--porcelain"], cwd);
  return stdout
    .split("\n")
    .filter(Boolean)
    .map((l) => l.slice(3).split(" -> ").pop().replace(/^"|"$/g, ""));
}

/**
 * Park a run's own uncommitted output in a stash so it can't wedge the repo.
 * A run that ends dirty — the agent worked but never committed — otherwise
 * blocks every later tick at preflight, so no queued task (and no TODO card the
 * human adds afterward) ever runs again. This is only ever called right after
 * the runner's own agent run, so the dirt is the runner's, not a human editing
 * the tree. Stashing clears the tree while keeping the work recoverable with
 * `git stash pop`. Returns the stash label, or null if nothing was parked.
 */
export async function parkDirty(cwd, filename) {
  const dirty = await dirtyPaths(cwd);
  if (!dirty.length) return null;
  const label = `runner: parked ${filename} at ${new Date().toISOString()}`;
  return (await ok(["stash", "push", "-u", "-m", label], cwd)) ? label : null;
}

/**
 * The agent did the work (or found nothing to do) but walked past the rename —
 * skill step 6 — so the file is still `-TODO` on a clean tree. Finish the
 * bookkeeping it skipped: append a short runner note if it wrote no Results,
 * rename to `-DONE`, and commit. Only ever called on a clean tree, so there is
 * no half-done work to lose; the queue slot closes instead of re-running the
 * same already-finished task three times and parking it. Returns the -DONE name.
 */
export async function autoFinish(cwd, taskDir, filename, moved) {
  const done = filename.replace(/-TODO\.md$/i, "-DONE.md");
  const path = join(cwd, taskDir, filename);
  const text = readFileSync(path, "utf8");
  if (!/^##\s+Results\b/im.test(text))
    writeFileSync(
      path,
      text.replace(/\s*$/, "") +
        "\n\n## Results\n\nThe agent finished the run but never renamed the file, " +
        "so the runner completed it. The tree was clean" +
        (moved
          ? " and the agent's commits are in"
          : " with nothing left to commit") +
        " — see the `.log` beside this file for the full session.\n",
    );
  renameSync(path, join(cwd, taskDir, done));
  await git(["add", "-A", "--", taskDir], cwd);
  await git(["commit", "-m", `docs(todo): finish ${done} (runner)`], cwd);
  return done;
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
 * Returns `{ reason, kind }` when the repo must be skipped, otherwise `{ notes,
 * handoff }`. `handoff` names a task number whose work was left on a branch:
 * it has been pushed, so the runner must not run that number again.
 *
 * `kind` is the *stable* half of the reason. A dirty tree grows a file at a time
 * while someone works in it, and dedup on the full message meant one push per new
 * file — a flood for what is one unchanged condition.
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
    return {
      kind: "dirty",
      reason: `dirty working tree — ${dirty.slice(0, 6).join(", ")}`,
    };
  }

  if (!(await ok(["fetch", "origin"], cwd)))
    return { kind: "fetch", reason: "cannot reach origin (fetch failed)" };

  const base = await baseBranch(cwd);
  const branch = await out(["branch", "--show-current"], cwd);
  if (!branch)
    return {
      kind: "detached",
      reason: `detached HEAD at ${await out(["rev-parse", "--short", "HEAD"], cwd)}`,
    };

  const notes = [];
  let handoff;
  if (branch !== base) {
    const ahead = Number(
      await out(["rev-list", "--count", `origin/${base}..HEAD`], cwd).catch(
        () => "0",
      ),
    );
    if (ahead && !(await ok(["push", "-u", "origin", "HEAD"], cwd)))
      return {
        reason: `on branch ${branch} with ${ahead} unpushed commit(s) that will not push`,
      };
    if (ahead)
      notes.push(
        `pushed ${branch} (${ahead} commit(s)) — merge it into ${base}`,
      );
    if (!(await ok(["checkout", base], cwd)))
      return { reason: `cannot leave branch ${branch} for ${base}` };
    notes.push(`switched ${branch} → ${base}`);
    const n = /^(\d{3,})-/.exec(branch);
    if (ahead && n) handoff = n[1];
  }

  if (!(await ok(["pull", "--ff-only"], cwd)))
    return {
      reason: `${base} has diverged from origin/${base} (pull --ff-only failed)`,
    };

  // A checkpoint commit left here would diverge the moment origin moves on.
  const local = await out(["rev-list", "--count", `origin/${base}..HEAD`], cwd);
  if (local !== "0" && (await ok(["push", "origin", "HEAD"], cwd)))
    notes.push(`pushed ${local} local commit(s) to ${base}`);

  return { notes, handoff };
}
