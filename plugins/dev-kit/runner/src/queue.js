/**
 * The task folder is the queue: NNN-*-TODO.md files, minus the ones we gave up on.
 * A task is retired by a `-DONE.md` (finished) or a `-BLOCKED.md` (the agent did its
 * half and a human owns the rest) — either way the runner must not pick it up again.
 *
 * Retirement is keyed by the whole stem, not the leading NNN. Numbers used to be
 * "next free slot in the folder" and are now the GitHub issue number, so two
 * unrelated tasks can share one: ezysmart-web's finished `019-errors-DONE.md` made
 * `019-task012Fix-TODO.md` (issue #19) invisible the moment the Kanban wrote it.
 */

import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { issueOf } from "./issue.js";
import { machineOf } from "./machine.js";
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

/** `019-task012Fix` — a task's identity across its -TODO/-DONE/-BLOCKED lives. */
export const stemOf = (name) => name.replace(/-(TODO|DONE|BLOCKED)\.md$/i, "");

/** `> After: #78, #80` — the PRs or issues that must land before this task may run. */
export const afterOf = (text) =>
  [
    ...(/^[ \t]*>[ \t]*after:(.*)$/im
      .exec(text ?? "")?.[1]
      .matchAll(/#(\d+)/g) ?? []),
  ].map((m) => m[1]);

/**
 * Every NNN-*-TODO.md with no -DONE/-BLOCKED sibling of its own, lowest number first.
 * `skip(task)` drops a task that is already in flight — in a pull request repo, one
 * whose PR is open: its file stays `-TODO` on the base branch until that PR merges,
 * and without the skip every tick would run it again.
 */
export function listPending(repoPath, dir, skip = () => false) {
  let entries;
  try {
    entries = readdirSync(join(repoPath, dir), { withFileTypes: true });
  } catch {
    return [];
  }
  const names = entries.filter((e) => e.isFile()).map((e) => e.name);
  const over = new Set(
    names.filter((n) => /-(DONE|BLOCKED)\.md$/i.test(n)).map(stemOf),
  );
  return names
    .filter((n) => /-TODO\.md$/i.test(n) && numberOf(n) && !over.has(stemOf(n)))
    .sort((a, b) => Number(numberOf(a)) - Number(numberOf(b)))
    .map((name) => {
      const path = join(repoPath, dir, name);
      // What the runner needs from the file is read here, alongside the stat, so
      // nothing downstream has to open it a second time.
      const text = readFileSync(path, "utf8");
      return {
        name,
        number: numberOf(name),
        stem: stemOf(name),
        path,
        machine: machineOf(text),
        issue: issueOf(text),
        after: afterOf(text),
        mtime: statSync(path).mtimeMs,
      };
    })
    .filter((task) => !skip(task));
}

/** The `-BLOCKED.md` this stem ended as, if it did — the agent's half is finished. */
export function blockedFile(repoPath, dir, stem) {
  try {
    return (
      readdirSync(join(repoPath, dir)).find(
        (n) => /-BLOCKED\.md$/i.test(n) && stemOf(n) === stem,
      ) ?? null
    );
  } catch {
    return null;
  }
}

/** Two attempts on the same unchanged file is enough: announce once, move on. */
export async function pick(repoName, pending) {
  for (const task of pending) {
    const n = state.tries(repoName, task.stem, task.mtime);
    if (n < 2) return task;
    if (n > 2) continue; // already announced, or handed off to a branch
    state.addTry(repoName, task.stem, task.mtime);
    await notify(
      "Runner ⏭ stuck task",
      `${repoName} ${task.name}\n\nRan twice without renaming to -DONE (or -BLOCKED, if a human has to finish it). Skipped so the queue advances — edit the file to retry.`,
    );
  }
  return null;
}
