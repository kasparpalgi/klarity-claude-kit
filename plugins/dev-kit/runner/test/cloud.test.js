/**
 * Cloud tasks (#86), end to end without the cloud: a fake `claude` that refuses to run
 * without a terminal (as the real one does) and prints what `claude --cloud` prints, a
 * fake `gh` that keeps its PRs in a file, and a scratch origin. Every path the runner
 * owns — HOME, state, ~/.claude.json — points into a temp dir, set before the import.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const root = mkdtempSync(join(tmpdir(), "cloud-"));
Object.assign(process.env, {
  PATH: `${join(root, "bin")}:${process.env.PATH}`,
  KANBAN_RUNNER_STATE: join(root, "state.json"),
  CLAUDE_CONFIG_FILE: join(root, ".claude.json"),
  PUSHBULLET_ACCESS_TOKEN: "",
  FAKE_ROOT: root,
  GIT_AUTHOR_NAME: "t",
  GIT_AUTHOR_EMAIL: "t@t.t",
  GIT_COMMITTER_NAME: "t",
  GIT_COMMITTER_EMAIL: "t@t.t",
});
const { cloudPrompt, ptyArgs, sessionUrl, finishedOn } =
  await import("../src/cloud.js");
const { cloudTick } = await import("../src/cloudTick.js");
const { machineFilter } = await import("../src/machine.js");
const state = await import("../src/state.js");

// What 2.1.322 printed for the probe session, escapes and all.
const SAID =
  "\x1b7\x1b[>4m\x1b[<uCreated cloud session: Runner task 086 probe\r\nView: https://claude.ai/code/session_01RBXHAZjTVu8sSzaTPrEPWg?from=cli&m=0\r\nResume with: claude --teleport session_01RBXHAZjTVu8sSzaTPrEPWg\r\n\x1b(B\x1b[>4m";

const FAKE_CLAUDE = `#!/bin/sh
[ -t 1 ] || { echo "Error: --cloud requires an interactive terminal." >&2; exit 1; }
[ "$1" = "--cloud" ] || exit 2
printf '%s' "$2" > "$FAKE_ROOT/prompt.txt"
shift 2; echo "$*" > "$FAKE_ROOT/flags.txt"
printf '${SAID.replace(/\x1b/g, "\\033").replace(/\r\n/g, "\\r\\n").replace(/%/g, "%%")}'
`;

// `gh pr list` answers from prs.json; `gh pr create` adds to it.
const FAKE_GH = `#!/usr/bin/env node
const fs = require("fs"), f = process.env.FAKE_ROOT + "/prs.json";
const prs = fs.existsSync(f) ? JSON.parse(fs.readFileSync(f)) : [];
const a = process.argv.slice(2), arg = (k) => a[a.indexOf(k) + 1];
if (a[1] === "list") console.log(JSON.stringify(arg("--state") === "open" ? prs : []));
if (a[1] === "create") {
  const n = 40 + prs.length, url = "https://github.com/o/r/pull/" + n;
  prs.push({ number: n, url, headRefName: arg("--head"), title: arg("--title"), body: arg("--body"), isDraft: a.includes("--draft"), files: [] });
  fs.writeFileSync(f, JSON.stringify(prs));
  console.log(url);
}
`;

const git = (cwd, ...a) => execFileSync("git", a, { cwd, encoding: "utf8" });

function scratch() {
  git(root, "init", "-q", "--bare", "-b", "main", "origin.git");
  git(root, "clone", "-q", "origin.git", "clone");
  const clone = join(root, "clone");
  mkdirSync(join(clone, "doc/todo"), { recursive: true });
  writeFileSync(
    join(clone, "doc/todo/007-x-TODO.md"),
    "> Run with: Sonnet 5 / low\n> Machine: cloud\n\n# Cloud smoke\n\n_GitHub issue #7 — end the commit subject with `(#7)`._\n",
  );
  git(clone, "add", "-A");
  git(clone, "commit", "-qm", "docs(todo): 007");
  git(clone, "push", "-q", "origin", "HEAD:main");
  mkdirSync(join(root, "bin"));
  writeFileSync(join(root, "bin/claude"), FAKE_CLAUDE);
  writeFileSync(join(root, "bin/gh"), FAKE_GH);
  chmodSync(join(root, "bin/claude"), 0o755);
  chmodSync(join(root, "bin/gh"), 0o755);
  return clone;
}

test("the prompt carries the skills, filled in, and the cloud's own rules", () => {
  const p = cloudPrompt({
    number: "086",
    stem: "086-cloudAsMachine",
    base: "main",
  });
  assert.match(p, /^Run Kanban task 086: \/todo 086\./);
  assert.match(p, /git switch -c todo\/086-cloudAsMachine/);
  assert.match(p, /Never push to `main`/);
  assert.match(p, /# Run task `086`/, "the /todo skill, its number filled in");
  assert.match(p, /<skill name="verify">\n\n# Verify/);
  assert.doesNotMatch(p, /\$ARGUMENTS|disable-model-invocation/);
});

test("the pseudo-terminal is spelled per platform", () => {
  assert.deepEqual(ptyArgs("linux", "x"), ["-qec", "x", "/dev/null"]);
  assert.deepEqual(ptyArgs("darwin", "x"), [
    "-q",
    "/dev/null",
    "sh",
    "-c",
    "x",
  ]);
});

test("the session link is read through the terminal's escapes", () => {
  assert.equal(
    sessionUrl(SAID),
    "https://claude.ai/code/session_01RBXHAZjTVu8sSzaTPrEPWg",
  );
  assert.equal(
    sessionUrl("Error: --cloud requires an interactive terminal."),
    null,
  );
});

test("a cloud task never runs on a machine, whatever it answers to", () => {
  assert.equal(machineFilter({})("cloud"), false);
  assert.equal(machineFilter({ machine: "karel" })("cloud"), false);
  assert.equal(machineFilter({ machine: "karel" })(null), true);
});

test("send, wait, then open the PR once the branch holds the rename", async (t) => {
  if (process.platform !== "linux" && process.platform !== "darwin")
    return t.skip("needs script(1)");
  const clone = scratch();
  const path = join(clone, "doc/todo/007-x-TODO.md");
  const task = () => ({
    name: "007-x-TODO.md",
    stem: "007-x",
    number: "007",
    path,
    mtime: statSync(path).mtimeMs,
    machine: "cloud",
  });
  const tick = () =>
    cloudTick({
      cfg: { kanban: {}, classifier: "Opus / low" },
      repoName: "o/r",
      repoPath: clone,
      dir: "doc/todo",
      base: "main",
      viaPr: false,
      tasks: [task()],
      log: () => {},
    });

  const [sent] = await tick();
  assert.match(
    sent,
    /^007-x-TODO\.md → https:\/\/claude\.ai\/code\/session_01RB/,
  );
  assert.match(readFileSync(join(root, "prompt.txt"), "utf8"), /\/todo 007/);
  assert.match(
    readFileSync(join(root, "flags.txt"), "utf8"),
    /--model claude-sonnet-5 --effort low/,
  );
  assert.deepEqual(await tick(), [], "a sent task is left to its session");

  // The session's work: a WIP push is not a finish, the rename is.
  git(clone, "switch", "-q", "-c", "todo/007-x");
  writeFileSync(join(clone, "notes.md"), "wip\n");
  git(clone, "add", "-A");
  git(clone, "commit", "-qm", "wip");
  git(clone, "push", "-q", "origin", "todo/007-x");
  git(clone, "switch", "-q", "main");
  git(clone, "fetch", "-q", "origin");
  assert.equal(await finishedOn(clone, "doc/todo", "main", "007-x"), false);
  assert.deepEqual(await tick(), []);

  git(clone, "switch", "-q", "todo/007-x");
  git(clone, "mv", "doc/todo/007-x-TODO.md", "doc/todo/007-x-DONE.md");
  git(clone, "commit", "-qm", "docs(todo): finish 007");
  git(clone, "push", "-q", "origin", "todo/007-x");
  git(clone, "switch", "-q", "main");
  git(clone, "fetch", "-q", "origin");
  assert.equal(await finishedOn(clone, "doc/todo", "main", "007-x"), true);
  assert.deepEqual(await tick(), [
    "007-x-TODO.md — opened PR #40",
    "007-x-TODO.md — PR #40 on the card",
  ]);
  const [pr] = JSON.parse(readFileSync(join(root, "prs.json"), "utf8"));
  assert.equal(pr.headRefName, "todo/007-x");
  assert.equal(pr.title, "Cloud smoke (#7)");
  assert.equal(
    pr.isDraft,
    false,
    "a push-to-main repo's PR waits for a person",
  );
  assert.match(pr.body, /claude\.ai\/code\/session_01RB[\s\S]*Closes #7/);
  assert.equal(state.cloudOf("o/r", "007-x").pr, 40);
  assert.deepEqual(await tick(), [], "the PR is said once");
  assert.ok(existsSync(path), "the -TODO stays on main until the merge");
});
