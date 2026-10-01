/**
 * The free tier: a Gemini card runs through aider, headless, instead of Claude.
 * aider has no /todo skill, so it only does the work and auto-commits it; the
 * runner's autoFinish then writes Results and the -DONE rename, as it does for
 * any agent that skips step 6. Install once per machine: `uv tool install aider-chat`,
 * and put GEMINI_API_KEY in ~/.config/kanban-runner.env.
 */

import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";

const PROMPT = (file) =>
  `Do the task described in ${file} (added read-only). Make the code changes its ` +
  `Original Requirement asks for, as small and simple as possible. Add any file you ` +
  `need to the chat yourself. Never edit ${file}.`;

/** `aider` argv for one task; `tier` comes from classify.js. */
export function aiderArgs(tier, taskPath) {
  return [
    "--model",
    tier.model,
    "--reasoning-effort",
    tier.effort,
    // aider's bundled table predates 3.8 Flash; litellm still maps the effort.
    "--no-check-model-accepts-settings",
    "--no-show-model-warnings",
    "--yes-always",
    "--no-gitignore",
    "--no-suggest-shell-commands",
    "--no-pretty",
    "--analytics-disable",
    "--read",
    taskPath,
    "--message",
    PROMPT(taskPath),
  ];
}

/**
 * aider drops `.aider*` history and caches in the repo root. Keep them out of
 * `git status` locally — a dirty tree parks the run — without a commit.
 */
export function excludeAiderFiles(repoPath) {
  const file = join(repoPath, ".git", "info", "exclude");
  mkdirSync(dirname(file), { recursive: true });
  const cur = existsSync(file) ? readFileSync(file, "utf8") : "";
  if (!cur.includes(".aider*")) appendFileSync(file, "\n.aider*\n");
}

/**
 * aider exits 0 even when every API call failed (bad key, quota), and a clean
 * exit with no -DONE reads as "nothing to do" to autoFinish. Its errors are
 * litellm's, so treat any of them as a failed run.
 */
export function aiderFailed(output) {
  return /litellm\.\w*Error|not able to authenticate|API key not valid/i.test(
    output,
  );
}
