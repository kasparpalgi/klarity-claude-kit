import { test } from "node:test";
import assert from "node:assert/strict";
import { explicitTier } from "../src/classify.js";

test("explicitTier resolves Opus 5.5 to its own model id", () => {
  const t = explicitTier("Run with: Opus 5.5 / high");
  assert.equal(t.model, "claude-opus-5-5");
  assert.equal(t.effort, "high");
});

test("explicitTier resolves Sonnet 5.5 to its own model id", () => {
  const t = explicitTier("Run with: Sonnet 5.5 / medium");
  assert.equal(t.model, "claude-sonnet-5-5");
  assert.equal(t.label, "Sonnet 5.5 / medium");
});

test("explicitTier routes Gemini 3.8 through aider", () => {
  const t = explicitTier("Run with: Gemini 3.8 / low");
  assert.equal(t.model, "gemini/gemini-3.8-flash");
  assert.equal(t.engine, "aider");
  assert.equal(t.label, "Gemini 3.8 / low");
});

test("Gemini caps effort at high", () => {
  const t = explicitTier("Run with: gemini / max");
  assert.equal(t.effort, "high");
});
