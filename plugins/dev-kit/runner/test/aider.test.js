import { test } from "node:test";
import assert from "node:assert/strict";
import { aiderArgs, aiderFailed } from "../src/aider.js";
import { explicitTier } from "../src/classify.js";

test("aiderArgs passes model, effort and the task file read-only", () => {
  const args = aiderArgs(
    explicitTier("Run with: Gemini 3.8 / low"),
    "doc/todo/044-x-TODO.md",
  );
  const at = (flag) => args[args.indexOf(flag) + 1];
  assert.equal(at("--model"), "gemini/gemini-3.8-flash");
  assert.equal(at("--reasoning-effort"), "low");
  assert.equal(at("--read"), "doc/todo/044-x-TODO.md");
  assert.ok(args.includes("--yes-always"));
});

test("aiderFailed catches the API errors aider exits 0 on", () => {
  assert.ok(
    aiderFailed(
      "The API provider is not able to authenticate you. Check your API key.",
    ),
  );
  assert.ok(aiderFailed("litellm.RateLimitError: quota exceeded"));
  assert.ok(!aiderFailed("Applied edit to src/a.js\nCommit 1a2b3c feat: x"));
});
