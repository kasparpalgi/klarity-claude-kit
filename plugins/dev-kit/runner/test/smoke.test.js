/**
 * End to end: one `run.js --once` tick picks a task up, runs "claude" in its
 * worktree and lands the -DONE rename on origin. A broken pickup otherwise shows
 * up only as "it didn't start" on every machine at once (svelte-hasura-boilerplate#89).
 * No herdr, no Kanban, no phone: HOME and every runner path point into a temp dir.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const RUN = fileURLToPath(new URL("../src/run.js", import.meta.url));

// A finished /todo session: rename the task the prompt names, then commit.
const FAKE_CLAUDE = `#!/bin/sh
set -e
[ "$1" = "-p" ] || exit 2
n=\${2#/todo }
f=$(ls doc/todo/"$n"-*-TODO.md)
git mv "$f" "\${f%-TODO.md}-DONE.md"
git commit -qm "docs(todo): finish $n"
`;

test("run.js --once runs a -TODO task and lands it -DONE on origin", () => {
  const root = mkdtempSync(join(tmpdir(), "smoke-"));
  // A temp HOME also keeps the machine's global git config (hooks, signing) out.
  const env = {
    ...process.env,
    HOME: root,
    PATH: `${join(root, "bin")}:${process.env.PATH}`,
    KANBAN_RUNNER_CONFIG: join(root, "config.json"),
    KANBAN_RUNNER_STATE: join(root, "state.json"),
    KANBAN_RUNNER_WORKTREES: join(root, "worktrees"),
    CLAUDE_CONFIG_FILE: join(root, ".claude.json"),
    NTFY_TOPIC: "",
    GIT_AUTHOR_NAME: "t",
    GIT_AUTHOR_EMAIL: "t@t.t",
    GIT_COMMITTER_NAME: "t",
    GIT_COMMITTER_EMAIL: "t@t.t",
  };
  const git = (cwd, ...a) =>
    execFileSync("git", a, { cwd, env, encoding: "utf8" }).trim();

  git(root, "init", "-q", "--bare", "-b", "main", "origin.git");
  git(root, "clone", "-q", "origin.git", "clone");
  const clone = join(root, "clone");
  mkdirSync(join(clone, "doc/todo"), { recursive: true });
  // An explicit tier, so no classifier call reaches the fake claude.
  writeFileSync(
    join(clone, "doc/todo/001-x-TODO.md"),
    "> Run with: Sonnet 5 / low\n\n# X\n",
  );
  git(clone, "add", "-A");
  git(clone, "commit", "-qm", "docs(todo): 001");
  git(clone, "push", "-q", "origin", "HEAD:main");

  mkdirSync(join(root, "bin"));
  writeFileSync(join(root, "bin/claude"), FAKE_CLAUDE);
  chmodSync(join(root, "bin/claude"), 0o755);
  writeFileSync(
    env.KANBAN_RUNNER_CONFIG,
    JSON.stringify({
      repos: { "o/smoke": clone },
      useHerdr: false,
      checkpointQuietSeconds: 0,
    }),
  );

  const r = spawnSync(process.execPath, [RUN, "--once"], {
    cwd: root,
    env,
    encoding: "utf8",
    timeout: 10_000,
  });
  const out = `${r.stdout}${r.stderr}`;
  assert.equal(r.status, 0, out);
  // The runner also commits a doc/todo/.gitignore for the run's .log.
  const tasks = git(
    root,
    "--git-dir=origin.git",
    "ls-tree",
    "--name-only",
    "main",
    "doc/todo/",
  )
    .split("\n")
    .filter((f) => f.endsWith(".md"));
  assert.deepEqual(tasks, ["doc/todo/001-x-DONE.md"], out);
});
