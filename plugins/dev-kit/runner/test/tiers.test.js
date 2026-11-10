import { test } from "node:test";
import assert from "node:assert/strict";
import { tierReport } from "../src/tiers.js";

const row = (todo_id, model, effort, mins, out, cost = 0) => ({
  todo_id,
  model,
  output_tokens: out,
  cost_usd: cost,
  started_at: "2026-11-10T10:00:00Z",
  ended_at: new Date(
    Date.parse("2026-11-10T10:00:00Z") + mins * 6e4,
  ).toISOString(),
  todo: effort ? { agent_effort: effort } : null,
});

test("tierReport groups by model + card effort and counts retries", () => {
  const r = tierReport([
    row("a", "claude-opus-5-5", "high", 10, 100, 1),
    row("a", "claude-opus-5-5", "high", 20, 300, 2),
    row("b", "claude-opus-5-5", "high", 30, 200),
    row("c", "claude-haiku-4-5-20251001", null, 2, 50),
  ]);
  assert.deepEqual(r[0], {
    tier: "opus-5-5 / high",
    sessions: 3,
    cards: 2,
    perCard: 1.5,
    minutes: 20,
    outTokens: 200,
    costUsd: 3,
  });
  assert.equal(r[1].tier, "haiku-4-5 / auto");
});
