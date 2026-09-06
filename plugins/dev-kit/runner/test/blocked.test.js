import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.KANBAN_RUNNER_STATE = join(
  mkdtempSync(join(tmpdir(), "runner-state-")),
  "state.json",
);
const state = await import("../src/state.js");

// A dirty tree grows a file at a time. Dedup keyed on the full message meant one
// push per new file; keyed on the kind it is one push per block.
test("one notification per block, not per changed file list", () => {
  assert.equal(state.setBlocked("repo", "dirty"), true);
  assert.equal(state.setBlocked("repo", "dirty"), false);
  assert.equal(state.setBlocked("repo", "fetch"), true);
  assert.equal(state.clearBlocked("repo"), true);
  assert.equal(state.clearBlocked("repo"), false);
});
