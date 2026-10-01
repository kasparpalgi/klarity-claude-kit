/**
 * Keep the checkout the runner runs *from* current.
 *
 * Two machines share this repo. A fix pushed from one reaches the other only
 * when a human pulls — and nobody does, because the daemon looks healthy: it
 * ticks, it runs tasks, it just runs them with two-day-old code. Karel resolved
 * "Opus 5.5" to plain Opus 5 for exactly that reason, reboot included, since
 * restarting the service re-runs the same stale files (#38).
 */

import { execFile } from "node:child_process";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const exec = promisify(execFile);

/** A credential prompt nobody can answer would hang the tick loop forever. */
const NO_PROMPT = { ...process.env, GIT_TERMINAL_PROMPT: "0" };

/** `src/`'s parent — the runner directory, wherever the clone happens to live. */
const RUNNER_DIR = dirname(dirname(fileURLToPath(import.meta.url)));

/**
 * Fast-forward the runner's own repo. Returns a one-line summary when new
 * commits landed — the caller then exits, and the supervisor (systemd
 * `Restart=always`, launchd `KeepAlive`) brings us back on the new code — or
 * null when there was nothing to take.
 *
 * A dirty tree means someone is developing in here, so we leave it alone:
 * `--ff-only` for the same reason, since a diverged branch is a person's
 * problem, not something to resolve behind their back.
 */
export async function selfUpdate(cwd = RUNNER_DIR) {
  const git = async (...args) =>
    (
      await exec("git", args, { cwd, timeout: 60000, env: NO_PROMPT })
    ).stdout.trim();
  if (await git("status", "--porcelain")) return null;
  const before = await git("rev-parse", "HEAD");
  await git("pull", "--ff-only");
  const after = await git("rev-parse", "HEAD");
  if (after === before) return null;
  return `↻ runner code updated to ${after.slice(0, 7)} — ${await git("log", "-1", "--format=%s")}`;
}
