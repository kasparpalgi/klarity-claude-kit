/**
 * The task folder is the queue: NNN-*-TODO.md files, minus the ones we gave up on.
 * A number is retired by a `-DONE.md` (finished) or a `-BLOCKED.md` (the agent did its
 * half and a human owns the rest) — either way the runner must not pick it up again.
 */

import { readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { notify } from "./notify.js";
import * as state from "./state.js";

/** Repo-relative task folder: `.claude/todo` when present, else `doc/todo`. */
export function todoDir(repoPath) {
  try {
    readdirSync(join(repoPath, ".claude", "todo"));
    return ".claude/todo";
  } catch {
    return "doc/todo";
  }
}

/** Leading NNN of a task filename — the GitHub issue number, so not always 3 digits. */
export const numberOf = (name) => /^(\d+)-/.exec(name)?.[1] ?? null;

/** Every NNN-*-TODO.md with no matching -DONE/-BLOCKED sibling, lowest number first. */
export function listPending(repoPath, dir) {
  let entries;
  try {
    entries = readdirSync(join(repoPath, dir), { withFileTypes: true });
  } catch {
    return [];
  }
  const names = entries.filter((e) => e.isFile()).map((e) => e.name);
  const over = new Set(
    names.filter((n) => /-(DONE|BLOCKED)\.md$/i.test(n)).map(numberOf),
  );
  return names
    .filter((n) => /-TODO\.md$/i.test(n) && numberOf(n) && !over.has(numberOf(n)))
    .sort((a, b) => Number(numberOf(a)) - Number(numberOf(b)))
    .map((name) => ({
      name,
      number: numberOf(name),
      mtime: statSync(join(repoPath, dir, name)).mtimeMs,
    }));
}

/** The `-BLOCKED.md` this number ended as, if it did — the agent's half is finished. */
export function blockedFile(repoPath, dir, number) {
  try {
    return (
      readdirSync(join(repoPath, dir)).find(
        (n) => numberOf(n) === number && /-BLOCKED\.md$/i.test(n),
      ) ?? null
    );
  } catch {
    return null;
  }
}

/** Two attempts on the same unchanged file is enough: announce once, move on. */
export async function pick(repoName, pending) {
  for (const task of pending) {
    const n = state.tries(repoName, task.number, task.mtime);
    if (n < 2) return task;
    if (n > 2) continue; // already announced, or handed off to a branch
    state.addTry(repoName, task.number, task.mtime);
    await notify(
      "Runner ⏭ stuck task",
      `${repoName} ${task.name}\n\nRan twice without renaming to -DONE (or -BLOCKED, if a human has to finish it). Skipped so the queue advances — edit the file to retry.`,
    );
  }
  return null;
}
