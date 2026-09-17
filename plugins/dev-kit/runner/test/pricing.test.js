import { test } from "node:test";
import assert from "node:assert/strict";
import { mapLitellmPricing, fetchClaudePricing } from "../src/pricing.js";

const SAMPLE = {
  "claude-sonnet-5": {
    litellm_provider: "anthropic",
    mode: "chat",
    input_cost_per_token: 0.000003,
    output_cost_per_token: 0.000015,
    cache_creation_input_token_cost: 0.00000375,
    cache_read_input_token_cost: 3e-7,
  },
  // No cache costs listed → fall back to input (write) and input/10 (read).
  "claude-haiku-mini": {
    litellm_provider: "anthropic",
    mode: "chat",
    input_cost_per_token: 0.000001,
    output_cost_per_token: 0.000005,
  },
  // Wrong provider / mode / non-claude → all dropped.
  "gpt-5": {
    litellm_provider: "openai",
    mode: "chat",
    input_cost_per_token: 1,
  },
  "claude-embed": {
    litellm_provider: "anthropic",
    mode: "embedding",
    input_cost_per_token: 1,
  },
  "claude-no-price": { litellm_provider: "anthropic", mode: "chat" },
};

test("maps per-token prices to per-Mtok and keeps only Claude chat models", () => {
  const rows = mapLitellmPricing(SAMPLE);
  assert.deepEqual(
    rows.map((r) => r.model),
    ["claude-haiku-mini", "claude-sonnet-5"],
  );
  const sonnet = rows.find((r) => r.model === "claude-sonnet-5");
  assert.equal(sonnet.input_per_mtok, 3);
  assert.equal(sonnet.output_per_mtok, 15);
  assert.equal(sonnet.cache_write_per_mtok, 3.75);
  assert.equal(sonnet.cache_read_per_mtok, 0.3);
  assert.equal(sonnet.currency, "USD");
  assert.equal(sonnet.source, "litellm");
});

test("cache prices fall back to input and input/10 when absent", () => {
  const haiku = mapLitellmPricing(SAMPLE).find(
    (r) => r.model === "claude-haiku-mini",
  );
  assert.equal(haiku.cache_write_per_mtok, 1);
  assert.equal(haiku.cache_read_per_mtok, 0.1);
});

test("empty or missing input is tolerated", () => {
  assert.deepEqual(mapLitellmPricing(null), []);
  assert.deepEqual(mapLitellmPricing({}), []);
});

test("fetchClaudePricing maps an injected response", async () => {
  const fake = async () => ({ ok: true, json: async () => SAMPLE });
  const rows = await fetchClaudePricing("x", fake);
  assert.equal(rows.length, 2);
});

test("fetchClaudePricing throws on a non-OK response", async () => {
  const fake = async () => ({ ok: false, status: 503 });
  await assert.rejects(fetchClaudePricing("x", fake), /HTTP 503/);
});
