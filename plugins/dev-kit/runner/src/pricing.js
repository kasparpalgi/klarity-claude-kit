/**
 * Claude token pricing, sourced from LiteLLM's public price list. Anthropic has
 * no pricing API, so a scheduled job pulls this JSON every few days and upserts
 * the Claude rows into Hasura (task 025). This module is the pure part: fetch the
 * list and shape the rows. Prices are stored per-million-tokens because that is
 * how humans read them; cost is `tokens / 1e6 * per_mtok`.
 */

// Raw price list maintained by the LiteLLM project. `main` tracks new models
// within days of release — but it can still lag a brand-new id (e.g. a just-shipped
// Opus), so a model with no row here is not an error, just "priced later".
export const LITELLM_URL =
  "https://raw.githubusercontent.com/BerriAI/litellm/main/model_prices_and_context_window.json";

const PER_MTOK = 1_000_000;
const mtok = (perToken) =>
  typeof perToken === "number" ? perToken * PER_MTOK : null;

/** Is this a Claude chat model with real input/output pricing? */
function isClaudeChat(key, v) {
  return (
    v &&
    v.litellm_provider === "anthropic" &&
    /claude/i.test(key) &&
    v.mode === "chat" &&
    typeof v.input_cost_per_token === "number" &&
    typeof v.output_cost_per_token === "number"
  );
}

/**
 * Shape the LiteLLM price map into upsert-ready rows, one per Claude chat model.
 * Cache-write falls back to input price when LiteLLM omits it, and cache-read to
 * a conventional tenth of input — so a row is always complete enough to cost with.
 */
export function mapLitellmPricing(json, source = "litellm") {
  const rows = [];
  for (const [model, v] of Object.entries(json ?? {})) {
    if (!isClaudeChat(model, v)) continue;
    const input = mtok(v.input_cost_per_token);
    rows.push({
      model,
      input_per_mtok: input,
      output_per_mtok: mtok(v.output_cost_per_token),
      cache_write_per_mtok: mtok(v.cache_creation_input_token_cost) ?? input,
      cache_read_per_mtok: mtok(v.cache_read_input_token_cost) ?? input / 10,
      currency: "USD",
      source,
    });
  }
  return rows.sort((a, b) => a.model.localeCompare(b.model));
}

/** Fetch the LiteLLM list and map it. `fetchFn`/`url` are injectable for tests. */
export async function fetchClaudePricing(url = LITELLM_URL, fetchFn = fetch) {
  const res = await fetchFn(url, { signal: AbortSignal.timeout(15000) });
  if (!res.ok) throw new Error(`LiteLLM price list HTTP ${res.status}`);
  return mapLitellmPricing(await res.json());
}

const UPSERT = `mutation U($rows: [claude_model_pricing_insert_input!]!) {
  insert_claude_model_pricing(
    objects: $rows
    on_conflict: {
      constraint: claude_model_pricing_pkey
      update_columns: [
        input_per_mtok
        output_per_mtok
        cache_write_per_mtok
        cache_read_per_mtok
        currency
        source
        updated_at
      ]
    }
  ) { affected_rows }
}`;

/**
 * Upsert pricing rows into Hasura, keyed on `model`. `gqlFn` is injectable for a
 * unit test — it defaults to a plain POST against `kanban.endpoint` with the
 * admin secret, the same shape `kanban.js`'s `gql()` uses.
 */
export async function upsertPricing(kanban, rows, gqlFn = defaultGql) {
  if (!rows.length) return 0;
  const objects = rows.map((r) => ({
    ...r,
    updated_at: new Date().toISOString(),
  }));
  const data = await gqlFn(kanban, UPSERT, { rows: objects });
  return data.insert_claude_model_pricing.affected_rows;
}

async function defaultGql(kanban, query, variables) {
  const res = await fetch(kanban.endpoint, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-hasura-admin-secret": kanban.adminSecret,
    },
    body: JSON.stringify({ query, variables }),
    signal: AbortSignal.timeout(15000),
  });
  const body = await res.json();
  if (body.errors)
    throw new Error(body.errors.map((e) => e.message).join("; "));
  return body.data;
}
