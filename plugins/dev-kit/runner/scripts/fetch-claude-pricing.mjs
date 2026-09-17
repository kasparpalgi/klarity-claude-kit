#!/usr/bin/env node
/**
 * Print the current Claude token prices from LiteLLM as upsert-ready rows.
 * Task 025 wires this into a scheduled job that upserts them into Hasura; for now
 * it is the verifiable half — `node scripts/fetch-claude-pricing.mjs` shows exactly
 * what would be stored (per-million-token USD).
 */
import { fetchClaudePricing } from "../src/pricing.js";

const rows = await fetchClaudePricing();
console.log(`${rows.length} Claude models (USD per 1M tokens)\n`);
console.log(
  ["model", "in", "out", "cache_w", "cache_r"]
    .map((h, i) => (i ? h.padStart(9) : h.padEnd(30)))
    .join(""),
);
for (const r of rows) {
  console.log(
    r.model.padEnd(30) +
      [
        r.input_per_mtok,
        r.output_per_mtok,
        r.cache_write_per_mtok,
        r.cache_read_per_mtok,
      ]
        .map((n) => String(n).padStart(9))
        .join(""),
  );
}
