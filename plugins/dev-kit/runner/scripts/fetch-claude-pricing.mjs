#!/usr/bin/env node
/**
 * Fetch current Claude token prices from LiteLLM and upsert them into Hasura.
 * `--dry-run` prints the rows instead (per-million-token USD) — no network write.
 * Runs on the ~3-day schedule set up in launchd.plist.example (task 025).
 */
import { loadConfig } from "../src/config.js";
import { fetchClaudePricing, upsertPricing } from "../src/pricing.js";

const dryRun = process.argv.includes("--dry-run");
const rows = await fetchClaudePricing();

if (dryRun) {
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
} else {
  const { kanban } = loadConfig();
  if (!kanban.endpoint || !kanban.adminSecret)
    throw new Error("config.json is missing endpoint/adminSecret");
  const affected = await upsertPricing(kanban, rows);
  console.log(`upserted ${affected} models`);
}
