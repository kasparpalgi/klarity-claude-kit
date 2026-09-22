/**
 * Make one local clone runnable: the repo on disk, the dev-kit plugin enabled for
 * it, a task folder, a CLAUDE.md the agent can read, and the stack's dependencies.
 *
 * Everything written here is committed and pushed. An untracked file anywhere
 * outside the task folder reads as `dirty` to preflight(), which blocks the repo —
 * onboarding it by leaving files lying in its tree would stop the runner from ever
 * running it.
 */

import { execFile } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { promisify } from "node:util";

const exec = promisify(execFile);

/** Why it failed, in one line: git says "To <url>" before it says what went wrong. */
const why = (err) => {
  const lines = String(err.stderr || err.message).trim().split("\n");
  return lines.find((l) => /^(error|fatal|!)/.test(l.trim())) ?? lines[0];
};

const run = (cmd, args, opts = {}) =>
  exec(cmd, args, { maxBuffer: 1 << 24, ...opts }).then(() => null, why);

/** First lockfile wins: `npm ci` needs the lock, `npm install` is the fallback. */
const STACKS = [
  { file: "pnpm-lock.yaml", name: "Node (pnpm)", install: ["pnpm", "install"] },
  { file: "bun.lockb", name: "Node (bun)", install: ["bun", "install"] },
  { file: "yarn.lock", name: "Node (yarn)", install: ["yarn", "install"] },
  { file: "package-lock.json", name: "Node (npm)", install: ["npm", "ci"] },
  { file: "package.json", name: "Node", install: ["npm", "install"] },
  { file: "uv.lock", name: "Python (uv)", install: ["uv", "sync"] },
  { file: "requirements.txt", name: "Python", install: null },
  { file: "go.mod", name: "Go", install: ["go", "mod", "download"] },
  { file: "Cargo.toml", name: "Rust", install: ["cargo", "fetch"] },
  { file: "pom.xml", name: "Java (Maven)", install: null },
];

/** What this repo is built with, by the files it keeps at its root. */
export const stackOf = (dir) =>
  STACKS.find((s) => existsSync(join(dir, s.file))) ?? {
    name: "unknown",
    install: null,
  };

/** The plugin is enabled per repo, next to whatever settings it already has. */
export function mergeSettings(current) {
  const next = { ...current };
  next.extraKnownMarketplaces = {
    klarity: { source: { source: "github", repo: "kasparpalgi/klarity-claude-kit" } },
    ...(next.extraKnownMarketplaces ?? {}),
  };
  next.enabledPlugins = { ...(next.enabledPlugins ?? {}), "dev-kit@klarity": true };
  return next;
}

/** Enough for `/plan` and `/todo` to behave; the first real task fills in the rest. */
export const claudeMd = (repo, stack) => `## Project Configuration

### About Project

[Describe this project in 1-2 sentences.]

- **Repo**: ${repo}
- **Stack**: ${stack}

IMPORTANT: develop in the main branch. Commit and push changes when the task is
done. For any other tasks do not ask for permissions.

## How work happens here

Every request becomes **one markdown file in \`doc/todo/\`** holding the original
prompt at the top and the outcome at the bottom. That folder is the prompt history —
never rewrite the top of a file.

| Step                                  | Command            |
| ------------------------------------- | ------------------ |
| Turn a request into a task file       | \`/plan <request>\`  |
| Execute a task file                   | \`/todo <number>\`   |
| Check a change                        | \`/verify\`          |
| Audit auth / secrets / input handling | \`/security-review\` |

These come from the **\`dev-kit\` plugin** (\`kasparpalgi/klarity-claude-kit\`),
enabled for this repo in \`.claude/settings.json\`.
`;

const writeIfAbsent = (path, body, steps, label) => {
  if (existsSync(path)) return;
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, body);
  steps.push(label);
};

/**
 * Clone if needed, then bring the checkout up to the standard every runner repo
 * meets. Idempotent: the second machine pulls what the first pushed and writes
 * nothing. Returns what it did and what a human still has to look at.
 */
export async function scaffold(repo, dir, { dryRun = false, install = true } = {}) {
  const steps = [];
  const warnings = [];
  const fresh = !existsSync(dir);

  if (fresh) {
    if (dryRun) return { steps: [`clone ${repo} → ${dir}`], warnings, cloned: true };
    mkdirSync(dirname(dir), { recursive: true });
    const err = await run("gh", ["repo", "clone", repo, dir], { timeout: 600_000 });
    if (err) return { steps, warnings: [`clone failed: ${err}`], failed: true };
    steps.push(`cloned → ${dir}`);
  } else if (!existsSync(join(dir, ".git"))) {
    return { steps, warnings: [`${dir} exists but is not a git clone`], failed: true };
  } else if (!dryRun) {
    // A stale clone would put the setup commit behind origin, and the push that
    // follows is then rejected non-fast-forward — which is how it read the first time.
    await run("git", ["fetch", "origin"], { cwd: dir, timeout: 120_000 });
    if (await run("git", ["pull", "--ff-only"], { cwd: dir, timeout: 120_000 })) {
      // Diverged, not merely behind — a setup commit from a run whose push failed
      // sits on an old base. Replaying it on origin is the same fix preflight() makes.
      const err = await run("git", ["pull", "--rebase"], { cwd: dir, timeout: 120_000 });
      if (err) {
        await run("git", ["rebase", "--abort"], { cwd: dir });
        warnings.push(`clone will not fast-forward or rebase onto origin: ${err}`);
      } else steps.push("rebased onto origin");
    }
  }
  if (dryRun) return { steps, warnings, cloned: false };

  const stack = stackOf(dir);
  const settings = join(dir, ".claude", "settings.json");
  const before = existsSync(settings) ? readFileSync(settings, "utf8") : "";
  const merged = JSON.stringify(mergeSettings(before ? JSON.parse(before) : {}), null, "\t") + "\n";
  if (merged !== before) {
    mkdirSync(dirname(settings), { recursive: true });
    writeFileSync(settings, merged);
    steps.push("enabled dev-kit@klarity");
  }
  if (!existsSync(join(dir, ".claude", "todo")))
    writeIfAbsent(join(dir, "doc", "todo", ".gitkeep"), "", steps, "created doc/todo/");
  writeIfAbsent(join(dir, "CLAUDE.md"), claudeMd(repo, stack.name), steps, "wrote CLAUDE.md stub");

  // Only what is actually there: git rejects the whole commit over one pathspec that
  // matches nothing, and a repo keeping its tasks in .claude/todo has no doc/.
  const paths = ["--", ...["CLAUDE.md", ".claude", "doc"].filter((p) => existsSync(join(dir, p)))];
  // Keyed off what is uncommitted, not off what this run wrote: a setup file whose
  // push failed last time is still sitting there dirty, blocking the repo.
  const pending = await exec("git", ["status", "--porcelain", ...paths], { cwd: dir })
    .then((r) => r.stdout.trim(), () => "");
  if (pending) {
    // Both halves are path-scoped: a repo mid-edit keeps its own work out of the
    // runner's setup commit.
    await run("git", ["add", "-A", ...paths], { cwd: dir });
    const err = await run("git", ["commit", "-m", "chore: enable the dev-kit agent workflow", ...paths], { cwd: dir });
    if (err) warnings.push(`could not commit the setup: ${err}`);
    else steps.push("committed the setup");
  }

  // Separate from the commit above: a rebase leaves the setup commit local, and a
  // push that failed once left it local too. Neither is uncommitted, so neither
  // would be retried if pushing were only ever the tail of a fresh commit.
  const ahead = await exec("git", ["rev-list", "--count", "@{u}..HEAD"], { cwd: dir })
    .then((r) => r.stdout.trim(), () => "0");
  if (ahead !== "0") {
    const err = await run("git", ["push", "origin", "HEAD"], { cwd: dir, timeout: 120_000 });
    if (err) warnings.push(`${ahead} commit(s) will not push: ${err}`);
    else steps.push(`pushed ${ahead} commit(s)`);
  }

  if (fresh && install && stack.install) {
    const err = await run(stack.install[0], stack.install.slice(1), { cwd: dir, timeout: 900_000 });
    steps.push(err ? `${stack.install.join(" ")} failed: ${err}` : `${stack.install.join(" ")} ok`);
  } else if (fresh && !stack.install && stack.name !== "unknown") {
    warnings.push(`${stack.name}: install its dependencies by hand`);
  }

  const { stdout } = await exec("git", ["status", "--porcelain"], { cwd: dir }).catch(() => ({ stdout: "" }));
  if (stdout.trim())
    warnings.push(`tree is dirty (${stdout.trim().split("\n").length} path(s)) — the runner will skip this repo until it is clean`);

  return { steps, warnings, cloned: fresh, stack: stack.name };
}
