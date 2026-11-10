#!/usr/bin/env node
/**
 * `npm run tiers [-- --days 30]` — which model/effort tier earns its cost.
 * Reads the `claude_usage` rows every run records; see src/tiers.js.
 */
import { loadConfig } from "../src/config.js";
import { gql } from "../src/kanban.js";
import { tierReport } from "../src/tiers.js";

const i = process.argv.indexOf("--days");
const days = i > 0 ? Number(process.argv[i + 1]) : 30;
const since = new Date(Date.now() - days * 864e5).toISOString();

const { kanban } = loadConfig();
if (!kanban.endpoint || !kanban.adminSecret)
  throw new Error("config.json is missing endpoint/adminSecret");

const { claude_usage: rows } = await gql(
  kanban,
  `query Q($since: timestamptz!) {
    claude_usage(where: {started_at: {_gte: $since}}) {
      todo_id model output_tokens cost_usd started_at ended_at
      todo { agent_effort }
    }
  }`,
  { since },
);

console.log(`${rows.length} sessions in the last ${days} days\n`);
console.table(tierReport(rows));
console.log(
  "perCard > 1 = retries. cost is 0 for a model LiteLLM has not priced yet.",
);
