/**
 * Tasks queued behind a blocked repo. A blocked repo is never pulled, so a task
 * the Kanban pushes afterward is invisible to this runner: the one "⛔ blocked"
 * ping went out hours or days ago, and the new card just sits in TODO, silently.
 * tektok-app's 458 waited like that behind two Tauri schemas that rust-analyzer
 * had regenerated (svelte-hasura-boilerplate#66).
 *
 * `git fetch` never touches the working tree, so it is safe on a dirty clone:
 * read origin's task folder and name the new tasks this machine owes.
 */

import { existsSync } from "node:fs";
import { join } from "node:path";
import { machineOf } from "./machine.js";
import { numberOf, stemOf } from "./queue.js";
import { baseBranch, git } from "./repo.js";

const out = async (args, cwd) => (await git(args, cwd)).stdout;

/**
 * `-TODO.md` files on origin's base branch that this checkout does not have,
 * addressed to this machine (`isMine` over the `> Machine:` slug). Empty when
 * origin cannot be read — the block reason already covers that.
 */
export async function waitingOnOrigin(repoPath, dir, isMine) {
  try {
    await git(["fetch", "origin"], repoPath);
    const ref = `origin/${await baseBranch(repoPath)}`;
    const names = (
      await out(["ls-tree", "--name-only", `${ref}:${dir}`], repoPath)
    )
      .split("\n")
      .filter(Boolean);
    const over = new Set(
      names.filter((n) => /-(DONE|BLOCKED)\.md$/i.test(n)).map(stemOf),
    );
    const fresh = names.filter(
      (n) =>
        /-TODO\.md$/i.test(n) &&
        numberOf(n) &&
        !over.has(stemOf(n)) &&
        !existsSync(join(repoPath, dir, n)),
    );
    const ours = [];
    for (const name of fresh) {
      const text = await out(["show", `${ref}:${dir}/${name}`], repoPath);
      if (isMine(machineOf(text))) ours.push(name);
    }
    return ours;
  } catch {
    return [];
  }
}
