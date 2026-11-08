import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.KANBAN_RUNNER_STATE = join(
  mkdtempSync(join(tmpdir(), "retry-")),
  "state.json",
);
const state = await import("../src/state.js");
const { todoPrompt } = await import("../src/retry.js");

const ending = {
  why: "exit 1",
  stash: "ab12cd3",
  log: "/repo/doc/todo/072-x.log",
};

test("attempt 1 gets the bare /todo, even with an ending on record", () => {
  assert.equal(todoPrompt("072", 1, null), "/todo 072");
  assert.equal(todoPrompt("072", 1, ending), "/todo 072");
});

test("attempt 2 names attempt 1's ending, stash commit and transcript", () => {
  const p = todoPrompt("072", 2, ending);
  assert.match(p, /^\/todo 072 This is attempt 2\. Attempt 1 ended: exit 1\./);
  assert.match(p, /stash commit ab12cd3/);
  assert.match(p, /git stash apply ab12cd3/);
  assert.match(p, /transcript is \/repo\/doc\/todo\/072-x\.log/);
});

test("attempt 2 with nothing recorded is the bare /todo", () => {
  assert.equal(todoPrompt("072", 2, null), "/todo 072");
});

test("no stash means no stash sentence", () => {
  assert.doesNotMatch(todoPrompt("072", 2, { why: "exit 1" }), /stash/);
});

test("characters that break a shell-style split are dropped", () => {
  const p = todoPrompt("072", 2, { why: 'it\'s `stuck`; $HOME #x "q"' });
  assert.doesNotMatch(p, /['"`;$#]/);
  assert.equal(p.split(" ")[1], "072");
});

test("the ending survives the next addTry and drops on a human edit", () => {
  state.addTry("r", "072-x", 100);
  state.setLast("r", "072-x", ending);
  assert.equal(state.addTry("r", "072-x", 100), 2);
  assert.deepEqual(state.lastEnding("r", "072-x", 100), ending);
  // A human edit moves the mtime: attempt 1 again, and no stale note.
  assert.equal(state.lastEnding("r", "072-x", 200), null);
  assert.equal(state.addTry("r", "072-x", 200), 1);
  assert.equal(state.lastEnding("r", "072-x", 200), null);
});

test("pruning a finished task drops its ending", () => {
  state.addTry("r2", "073-y", 1);
  state.setLast("r2", "073-y", ending);
  state.pruneTries("r2", []);
  assert.equal(state.lastEnding("r2", "073-y", 1), null);
});
