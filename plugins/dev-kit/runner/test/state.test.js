import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.KANBAN_RUNNER_STATE = join(
  mkdtempSync(join(tmpdir(), "state-")),
  "state.json",
);
const state = await import("../src/state.js");

test("cooldownUntil is 0 before any cooldown is set", () => {
  assert.equal(state.cooldownUntil(), 0);
});

test("a future cooldown is reported back", () => {
  const until = Date.now() + 60_000;
  state.setCooldown(until);
  assert.equal(state.cooldownUntil(), until);
});

test("a past cooldown reads as 0, not the stale timestamp", () => {
  state.setCooldown(Date.now() - 1000);
  assert.equal(state.cooldownUntil(), 0);
});

test("getLastRepo is null before any repo has run", () => {
  assert.equal(state.getLastRepo(), null);
});

test("setLastRepo/getLastRepo round-trip", () => {
  state.setLastRepo("kasparpalgi/ezysmart-web");
  assert.equal(state.getLastRepo(), "kasparpalgi/ezysmart-web");
});

test("tries uses stem key — same number different stem = separate counters", () => {
  const mtime = Date.now();
  state.addTry("repo", "019-errors", mtime);
  state.addTry("repo", "019-task012Fix", mtime);
  assert.equal(state.tries("repo", "019-errors", mtime), 1);
  assert.equal(state.tries("repo", "019-task012Fix", mtime), 1);
});

test("pruneTries by stem drops entries whose stem is gone", () => {
  const mtime = Date.now();
  state.addTry("repo2", "020-foo", mtime);
  state.addTry("repo2", "021-bar", mtime);
  state.pruneTries("repo2", ["021-bar"]);
  assert.equal(state.tries("repo2", "020-foo", mtime), 0);
  assert.equal(state.tries("repo2", "021-bar", mtime), 1);
});
