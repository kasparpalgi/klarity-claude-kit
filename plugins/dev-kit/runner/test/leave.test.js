/** A card dragged out of the agent list mid-run (svelte-hasura-boilerplate#73). */
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { onList, unpush, watchCard } from "../src/leave.js";

const TASK = "007-thing-TODO.md";

/** Our clone mid-run, and the Kanban's clone that can move the card on origin. */
function setup() {
  const origin = mkdtempSync(join(tmpdir(), "origin-"));
  execFileSync("git", ["init", "-q", "--bare", "-b", "main", origin]);
  const kanban = mkdtempSync(join(tmpdir(), "kanban-"));
  const k = (...a) => execFileSync("git", a, { cwd: kanban }).toString();
  k("init", "-q", "-b", "main");
  k("config", "user.email", "t@t.t");
  k("config", "user.name", "t");
  k("remote", "add", "origin", origin);
  mkdirSync(join(kanban, "doc/todo"), { recursive: true });
  writeFileSync(join(kanban, "doc/todo", TASK), "task\n");
  k("add", "-A");
  k("commit", "-qm", "queued");
  k("push", "-q", "-u", "origin", "main");
  const path = mkdtempSync(join(tmpdir(), "clone-"));
  execFileSync("git", ["clone", "-q", origin, path]);
  const c = (...a) => execFileSync("git", a, { cwd: path }).toString();
  c("config", "user.email", "t@t.t");
  c("config", "user.name", "t");
  const move = (to) => {
    k("mv", `doc/todo/${TASK}`, `doc/todo/${to}`);
    k("commit", "-qm", "moved");
    k("push", "-q");
  };
  return { path, c, move };
}

const look = (path) => onList(path, "doc/todo", TASK, "main");

test("a queued task is on the list", async () => {
  assert.equal(await look(setup().path), true);
});

test("a card moved back to a draft has left the list", async () => {
  const { path, c, move } = setup();
  move("007-thing.md");
  assert.equal(await look(path), false);
  // A fetch, never a pull: the clone's tree and its origin/main are untouched.
  assert.match(c("ls-files", "doc/todo"), /007-thing-TODO\.md/);
  assert.equal(c("rev-parse", "origin/main"), c("rev-parse", "HEAD"));
});

test("the agent's own finish is not a card leaving", async () => {
  const { path, move } = setup();
  move("007-thing-DONE.md");
  assert.equal(await look(path), true);
});

test("an unreadable origin is unknown, not gone", async () => {
  assert.equal(await look(mkdtempSync(join(tmpdir(), "no-git-"))), null);
});

const tick = () => new Promise((r) => setTimeout(r, 30));

test("onLeft fires once, on the edge from seen to gone", async () => {
  const answers = [true, null, false, false];
  let left = 0;
  const stop = watchCard({
    pollMs: 5,
    check: async () => answers.shift() ?? false,
    onLeft: () => left++,
  });
  await tick();
  stop();
  assert.equal(left, 1);
});

test("a task origin never had is never stopped", async () => {
  let left = 0;
  const stop = watchCard({
    pollMs: 5,
    check: async () => false,
    onLeft: () => left++,
  });
  await tick();
  stop();
  assert.equal(left, 0);
});

test("unpush turns unpushed commits into staged work for the stash", async () => {
  const { path, c } = setup();
  writeFileSync(join(path, "work.txt"), "half done\n");
  c("add", "-A");
  c("commit", "-qm", "agent commit");
  await unpush(path, "main");
  assert.equal(c("rev-parse", "HEAD"), c("rev-parse", "origin/main"));
  assert.match(c("status", "--porcelain"), /^A {2}work\.txt/m);
});
