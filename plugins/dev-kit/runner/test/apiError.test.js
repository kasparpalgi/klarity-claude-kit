import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { lastApiError, usageLimitHit } from "../src/usage.js";

const WALL = "You've hit your 5-hour limit · resets 4:20pm (Europe/Tallinn)";

/** A transcript as Claude Code writes it: one JSON entry per line. */
function transcript(...entries) {
  const file = join(mkdtempSync(join(tmpdir(), "apierr-")), "s.jsonl");
  writeFileSync(file, entries.map((e) => JSON.stringify(e)).join("\n"));
  return file;
}
const user = { type: "user", message: { content: "/todo 18" } };
const reply = (text, extra = {}) => ({
  type: "assistant",
  message: { model: "claude-opus-5-5", content: [{ type: "text", text }] },
  ...extra,
});
const wall = {
  type: "assistant",
  isApiErrorMessage: true,
  error: "rate_limit",
  message: { model: "<synthetic>", content: [{ type: "text", text: WALL }] },
};

test("a session that ended on the wall gives its message, and the wall is read from it", () => {
  const text = lastApiError(transcript(user, wall));
  assert.equal(text, WALL);
  // The Mac's 018: the pane showed nothing usable, the transcript did (#19).
  assert.equal(usageLimitHit(`\n${text}`)?.scope, "session");
});

test("a session that recovered and answered ended on no error", () => {
  assert.equal(lastApiError(transcript(user, wall, reply("done"))), "");
});

test("a subagent's error is not how the session ended", () => {
  const side = { ...wall, isSidechain: true };
  assert.equal(lastApiError(transcript(user, reply("working"), side)), "");
});

test("no transcript, or an unreadable line, is no error", () => {
  assert.equal(lastApiError(null), "");
  assert.equal(lastApiError(join(tmpdir(), "no-such-session.jsonl")), "");
  const file = transcript(user, wall);
  writeFileSync(file, "\n{not json\n", { flag: "a" });
  assert.equal(lastApiError(file), WALL);
});
