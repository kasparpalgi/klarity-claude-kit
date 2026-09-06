/** The task folder is the queue: NNN-*-TODO.md files, minus the ones we gave up on. */

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

/** Every NNN-*-TODO.md with no matching NNN-*-DONE.md, lowest number first. */
export function listPending(repoPath, dir) {
  let entries;
  try {
    entries = readdirSync(join(repoPath, dir), { withFileTypes: true });
  } catch {
    return [];
  }
  const names = entries.filter((e) => e.isFile()).map((e) => e.name);
  const done = new Set(
    names.filter((n) => /-DONE\.md$/i.test(n)).map((n) => n.slice(0, 3)),
  );
  return names
    .filter((n) => /-TODO\.md$/i.test(n) && !done.has(n.slice(0, 3)))
    .sort()
    .map((name) => ({
      name,
      number: name.slice(0, 3),
      mtime: statSync(join(repoPath, dir, name)).mtimeMs,
    }));
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
      `${repoName} ${task.name}\n\nRan twice without renaming to -DONE. Skipped so the queue advances — edit the file to retry.`,
    );
  }
  return null;
}
