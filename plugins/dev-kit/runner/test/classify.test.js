import { test } from "node:test";
import assert from "node:assert/strict";
import { downgrade, explicitTier } from "../src/classify.js";

test("downgrade drops effort before family", () => {
  const opusHigh = explicitTier("Run with: Opus 5 / high");
  const step1 = downgrade(opusHigh);
  assert.equal(step1.model, opusHigh.model);
  assert.notEqual(step1.effort, opusHigh.effort);
});

test("downgrade steps down family once effort is already low", () => {
  const opusLow = {
    model: "claude-opus-5",
    effort: "low",
    label: "Opus 5 / low",
  };
  const step = downgrade(opusLow);
  assert.equal(step.model, explicitTier("Run with: sonnet").model);
});

test("explicitTier resolves Opus 5.5 to its own model id", () => {
  const t = explicitTier("Run with: Opus 5.5 / high");
  assert.equal(t.model, "claude-opus-5-5");
  assert.equal(t.effort, "high");
});

test("downgrade returns null once already at the cheapest tier", () => {
  const haikuLow = explicitTier("Run with: haiku / low");
  assert.equal(downgrade(haikuLow), null);
});
