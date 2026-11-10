/**
 * "Cloud" on a card (svelte-hasura-boilerplate#86): the task runs in a Claude Code cloud
 * session, not on a machine of ours. The one runner with `cloud: true` starts it with
 * `claude --cloud`, links the session on the card and goes back to its queue: it never
 * waits on one. The session pushes `todo/<stem>`; once that branch holds the task's
 * -DONE/-BLOCKED rename, a later tick opens the pull request, and the task finishes like
 * any PR's — its merge brings the rename, and reconcileCards moves the card.
 *
 * Plugins never load in a cloud session, so its first message carries the /todo and
 * /verify skills' own text: this runner's copy, which cannot drift from a local run's.
 */

import { execFile, spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { basename } from "node:path";
import { promisify } from "node:util";
import { git } from "./repo.js";
import { stemOf } from "./queue.js";

const run = promisify(execFile);
const SKILLS = new URL("../../skills/", import.meta.url);

/** A skill's body without its frontmatter, `$ARGUMENTS` filled in. */
const skill = (name, args = "") =>
  readFileSync(new URL(`${name}/SKILL.md`, SKILLS), "utf8")
    .replace(/^---\n[\s\S]*?\n---\n/, "")
    .replace(/\$ARGUMENTS(\[0\])?/g, args);

export const cloudBranch = (stem) => `todo/${stem}`;

/** The session's first message: how the cloud differs, then the skills it cannot load. */
export function cloudPrompt({ number, stem, base }) {
  const branch = cloudBranch(stem);
  return `Run Kanban task ${number}: /todo ${number}. This is a Claude Code cloud session, where plugins do not load, so the /todo and /verify skills are pasted below. Follow them as if /todo ${number} had loaded.

Where this session differs from them:
- Work on the branch \`${branch}\`: \`git switch -c ${branch}\` before your first commit. Never push to \`${base}\`.
- Ship with \`git push -u origin ${branch}\`, and do not open a pull request yourself: the runner opens it once that branch holds the renamed task file.
- There is no Hasura, database or home network here. Run the checks that work without them, and name the ones you could not run in Results.

<skill name="todo">
${skill("todo", number)}
</skill>

<skill name="verify">
${skill("verify")}
</skill>
`;
}

/** `claude --cloud` will not start without a terminal, so it gets a pseudo one. */
export const ptyArgs = (platform, cmd) =>
  platform === "darwin"
    ? ["-q", "/dev/null", "sh", "-c", cmd]
    : ["-qec", cmd, "/dev/null"];

const ANSI =
  /\x1b\[[0-?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b[()][0-9A-Z]/g;
export const plain = (s) => s.replace(ANSI, "").replace(/\r/g, "");

/** The `claude.ai/code/session_…` link the CLI prints, without its query string. */
export const sessionUrl = (out) =>
  /https:\/\/claude\.ai\/code\/session_\w+/.exec(plain(out))?.[0] ?? null;

/** Start the session from `cwd` — a clone on its pushed base branch. Returns its link. */
export function startCloud({ cwd, prompt, tier, timeoutMs = 120_000 }) {
  // Gemini runs through aider, which the cloud has not got: there it gets the default model.
  const flags = tier.engine ? "" : ' --model "$KR_MODEL" --effort "$KR_EFFORT"';
  const cmd = `exec claude --cloud "$KR_PROMPT"${flags}`;
  const env = {
    ...process.env,
    KR_PROMPT: prompt,
    KR_MODEL: tier.model ?? "",
    KR_EFFORT: tier.effort ?? "",
  };
  return new Promise((resolve, reject) => {
    const child = spawn("script", ptyArgs(process.platform, cmd), {
      cwd,
      env,
      stdio: ["ignore", "pipe", "pipe"],
      timeout: timeoutMs,
    });
    let out = "";
    child.stdout.on("data", (c) => (out += c));
    child.stderr.on("data", (c) => (out += c));
    child.on("error", reject);
    child.on("close", (code) => {
      const url = sessionUrl(out);
      if (url) return resolve(url);
      const said = plain(out).trim().split("\n").slice(-6).join("\n");
      reject(new Error(said || `claude --cloud exited ${code}`));
    });
  });
}

/** True once the session's pushed branch holds this task's -DONE or -BLOCKED file. */
export async function finishedOn(repoPath, dir, base, stem) {
  const ref = `refs/remotes/origin/${cloudBranch(stem)}`;
  const { stdout } = await git(
    [
      "diff",
      "--name-only",
      "--no-renames",
      "--diff-filter=A",
      `origin/${base}...${ref}`,
      "--",
      dir,
    ],
    repoPath,
  ).catch(() => ({ stdout: "" }));
  return stdout
    .split("\n")
    .some(
      (f) => /-(DONE|BLOCKED)\.md$/i.test(f) && stemOf(basename(f)) === stem,
    );
}

/** Open the PR for a finished session's branch: ready for a person, or a draft for CI's review. */
export async function openCloudPr({
  repoName,
  base,
  stem,
  title,
  issue,
  url,
  draft,
}) {
  const body = [
    `Ran in a Claude Code cloud session: ${url}`,
    `\nThe session pushed \`${cloudBranch(stem)}\` with its renamed task file; the runner opened this PR.`,
    issue ? `\nCloses #${issue}` : "",
  ].join("\n");
  const { stdout } = await run(
    "gh",
    [
      "pr",
      "create",
      "--repo",
      repoName,
      "--base",
      base,
      "--head",
      cloudBranch(stem),
      "--title",
      `${title}${issue ? ` (#${issue})` : ""}`,
      "--body",
      body,
      ...(draft ? ["--draft"] : []),
    ],
    { timeout: 60_000 },
  );
  const prUrl = stdout.trim().split("\n").pop();
  return { number: Number(/\/pull\/(\d+)/.exec(prUrl)?.[1]), url: prUrl };
}
