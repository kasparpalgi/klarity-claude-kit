#!/usr/bin/env node
/**
 * `npm run tiers [-- --days 30]` — which model/effort tier earns its cost.
 * Reads the `claude_usage` rows every run records; see src/tiers.js.
 */
import { loadConfig } from "../src/config.js";
import { hasKanban, runnerApi } from "../src/kanban.js";
import { tierReport } from "../src/tiers.js";

const i = process.argv.indexOf("--days");
const days = i > 0 ? Number(process.argv[i + 1]) : 30;
const since = new Date(Date.now() - days * 864e5).toISOString();

const { kanban } = loadConfig();
if (!hasKanban(kanban)) throw new Error("config.json is missing apiToken");

const rows = await runnerApi(kanban, "usage", { since });

console.log(`${rows.length} sessions in the last ${days} days\n`);
console.table(tierReport(rows));
console.log(
  "perCard > 1 = retries. cost is 0 for a model LiteLLM has not priced yet.",
);
