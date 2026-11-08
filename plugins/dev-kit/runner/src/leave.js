/**
 * A card dragged out of the agent list mid-run (svelte-hasura-boilerplate#73).
 * The Kanban renames its `-TODO.md` back to a draft, or deletes it, but the tick
 * loop is parked inside the run — `agent prompt --wait` blocks for up to
 * taskMinutes — so no tick ever sees it. This watches origin alongside the run.
 */

import { stemOf } from "./queue.js";
import { git } from "./repo.js";

/**
 * Whether origin's base branch still holds this task as `-TODO`, `-DONE` or
 * `-BLOCKED` (the agent's own finish renames it). Null when origin cannot be
 * read: offline is not a reason to stop a run.
 *
 * Fetched into a private ref, with no FETCH_HEAD and no remote-tracking update,
 * so it never races the agent's own `git pull` for a ref lock.
 */
export async function onList(repoPath, dir, filename, base) {
  const ref = `refs/kanban-runner/${base}`;
  try {
    await git(
      [
        "fetch",
        "-q",
        "--no-write-fetch-head",
        "--refmap=",
        "origin",
        `+refs/heads/${base}:${ref}`,
      ],
      repoPath,
    );
    const { stdout } = await git(
      ["ls-tree", "--name-only", `${ref}:${dir}`],
      repoPath,
    );
    const stem = stemOf(filename);
    return stdout
      .split("\n")
      .some((n) => /-(TODO|DONE|BLOCKED)\.md$/i.test(n) && stemOf(n) === stem);
  } catch {
    return null;
  }
}

/**
 * Every pollMs until stopped. onLeft fires once, on the edge: the task was seen
 * on origin, then is gone. A task file origin never had (a local-only `/plan`)
 * is never a card that left. Stopping also cancels a check still in flight.
 */
export function watchCard({ check, pollMs, onLeft }) {
  let seen = false;
  let over = false;
  let busy = false;
  const poll = async () => {
    if (busy || over) return;
    busy = true;
    const on = await check().catch(() => null);
    busy = false;
    if (on) seen = true;
    if (on === false && seen && !over) {
      over = true;
      clearInterval(timer);
      onLeft();
    }
  };
  const timer = setInterval(poll, pollMs);
  poll(); // the first look now: a run starts right after the pull that found it
  return () => {
    over = true;
    clearInterval(timer);
  };
}

/**
 * Turn commits the stopped agent made but never pushed back into staged changes,
 * so the stash takes them. Left as commits, the next tick's preflight pushes
 * them — the very finish the card's move was meant to cancel.
 */
export async function unpush(cwd, base) {
  const up = `origin/${base}`;
  try {
    await git(["merge-base", "--is-ancestor", up, "HEAD"], cwd);
    await git(["reset", "-q", "--soft", up], cwd);
  } catch {
    // Diverged or no upstream: leave the commits to preflight's own handling.
  }
}
