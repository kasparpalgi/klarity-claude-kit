/**
 * Runner state that must outlive a tick, kept outside every repo so it can
 * never dirty a working tree: which repos are blocked (so we notify on the
 * edge, not every 20s) and how often a task number has been attempted.
 */

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

const FILE =
  process.env.KANBAN_RUNNER_STATE ??
  join(homedir(), ".kanban-runner", "state.json");

const EMPTY = { blocked: {}, tries: {} };

function read() {
  try {
    return { ...EMPTY, ...JSON.parse(readFileSync(FILE, "utf8")) };
  } catch {
    return structuredClone(EMPTY);
  }
}

function write(s) {
  mkdirSync(dirname(FILE), { recursive: true });
  writeFileSync(FILE, JSON.stringify(s, null, 2));
}

/** True only when the reason is new — the caller notifies on that edge alone. */
export function setBlocked(repo, reason) {
  const s = read();
  if (s.blocked[repo] === reason) return false;
  s.blocked[repo] = reason;
  write(s);
  return true;
}

/** True when the repo had been blocked, so recovery is worth one notification. */
export function clearBlocked(repo) {
  const s = read();
  if (!s.blocked[repo]) return false;
  delete s.blocked[repo];
  write(s);
  return true;
}

const key = (repo, number) => `${repo}#${number}`;

/**
 * Attempts are keyed by the task file's mtime: editing the file is the human
 * saying "try again", and resets the count without any extra command.
 */
export function tries(repo, number, mtime) {
  const e = read().tries[key(repo, number)];
  return e && e.mtime === mtime ? e.count : 0;
}

export function addTry(repo, number, mtime, count = 1) {
  const s = read();
  const prev = tries(repo, number, mtime);
  s.tries[key(repo, number)] = { count: prev + count, mtime };
  write(s);
  return prev + count;
}

/** Forget numbers that are no longer pending, so a reused NNN starts fresh. */
export function pruneTries(repo, pendingNumbers) {
  const s = read();
  let changed = false;
  for (const k of Object.keys(s.tries)) {
    if (!k.startsWith(`${repo}#`)) continue;
    if (pendingNumbers.includes(k.slice(repo.length + 1))) continue;
    delete s.tries[k];
    changed = true;
  }
  if (changed) write(s);
}

export const snapshot = () => read();
