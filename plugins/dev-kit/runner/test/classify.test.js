import { test } from "node:test";
import assert from "node:assert/strict";
import {
  classify,
  explicitTier,
  parseTier,
  readAnswer,
} from "../src/classify.js";

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

test("a bare tier reads like a Run with: line", () => {
  assert.equal(parseTier("Opus / low").label, "Opus 5.5 / low");
  assert.equal(parseTier("Sonnet 4.6 / high").model, "claude-sonnet-4-6");
});

test("the classifier's answer sets family and effort", () => {
  assert.equal(readAnswer("sonnet high").label, "Sonnet 5.5 / high");
  assert.equal(readAnswer("Opus").label, "Opus 5.5 / high");
  assert.equal(readAnswer("no idea"), null);
});

test("classify asks the configured judge and keeps its effort pick", async () => {
  let argv;
  const exec = async (_cmd, args) => (
    (argv = args),
    { stdout: "haiku medium\n" }
  );
  const t = await classify("rename a button", "Sonnet 5.5 / low", exec);
  assert.equal(t.label, "Haiku 4.5 / medium");
  assert.deepEqual(argv.slice(-4), [
    "--model",
    "claude-sonnet-5-5",
    "--effort",
    "low",
  ]);
});

test("classify never judges with Gemini, and falls back to sonnet on error", async () => {
  let argv;
  const exec = async (_cmd, args) => {
    argv = args;
    throw new Error("down");
  };
  const t = await classify("x", "Gemini 3.8 / low", exec);
  assert.equal(argv.at(-3), "claude-opus-5-5");
  assert.equal(t.label, "Sonnet 5.5 / medium");
});

test("an explicit Run with: line skips the classifier", async () => {
  const exec = async () => assert.fail("classifier must not run");
  const t = await classify("> Run with: Haiku / low", "Opus / low", exec);
  assert.equal(t.label, "Haiku 4.5 / low");
});
