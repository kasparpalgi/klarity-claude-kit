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
