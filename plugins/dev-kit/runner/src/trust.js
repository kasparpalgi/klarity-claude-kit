/**
 * Claude asks "do you trust the files in this folder?" the first time it starts
 * interactively somewhere it has never been. `-p` skips that dialog, so the old
 * headless path never met it — but a herdr pane is a real TTY, and there the
 * dialog is a wall: the agent never registers, `agent read` answers
 * `agent_not_found`, and the task burns an attempt with a two-line log and no
 * transcript. That is what happened to every fresh clone (task-032).
 *
 * So answer it before it is asked. The flag lives per project path in
 * ~/.claude.json, and setting it is exactly what the dialog does.
 */

import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve, sep } from "node:path";

const configPath = () =>
  process.env.CLAUDE_CONFIG_FILE ?? join(homedir(), ".claude.json");

/**
 * Mark `dir` trusted, and say whether it had to write. Claude owns this file and
 * rewrites it whole, so we touch it only when the flag is genuinely missing —
 * once per repo, ever — and swap the new copy in with a rename.
 */
export function trustProject(dir, path = configPath()) {
  const key = resolve(dir);
  const cfg = read(path);
  if (!cfg || cfg.projects?.[key]?.hasTrustDialogAccepted) return false;
  cfg.projects = {
    ...cfg.projects,
    [key]: { ...cfg.projects?.[key], hasTrustDialogAccepted: true },
  };
  write(cfg, path);
  return true;
}

/**
 * Drop the entries of folders under `root` that no longer exist. Every task's worktree
 * is trusted once, so without this ~/.claude.json keeps one dead entry per task (#91).
 * Returns how many went.
 */
export function untrustGone(root, path = configPath()) {
  const cfg = read(path);
  const gone = Object.keys(cfg?.projects ?? {}).filter(
    (k) => k.startsWith(resolve(root) + sep) && !existsSync(k),
  );
  if (!gone.length) return 0;
  for (const k of gone) delete cfg.projects[k];
  write(cfg, path);
  return gone.length;
}

/** Null when mid-write or hand-broken: never overwrite what we cannot read. */
function read(path) {
  if (!existsSync(path)) return {};
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return null;
  }
}

function write(cfg, path) {
  const tmp = `${path}.runner-${process.pid}`;
  writeFileSync(tmp, JSON.stringify(cfg, null, 2) + "\n", { mode: 0o600 });
  renameSync(tmp, path);
}
