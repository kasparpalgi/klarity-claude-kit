> Run with: Sonnet 5 / medium

# A `claude_usage` row with an unpriced model still stores a cost floor

## Original Requirement

[NEVER REMOVE]

Split out of #19 (`019-unpricedCostShowsZero`). The runner now pulls LiteLLM's prices
itself when a model has none. If a model is still unpriced, the card says `cost unknown`.
But the `claude_usage` row still stores the priced part, which is `0` when nothing was
priced. That is because the Kanban (svelte-todo-kanban) declares `cost_usd` as `NOT NULL`
in three places: the Hasura migration, the D1 `real().notNull()` schema and the
`recordUsage` zod `money` input. A runner that sent `null` would lose the whole row.

1. **Kanban repo:** make `claude_usage.cost_usd` nullable on both backends and in the
   `recordUsage` input. Sums already treat null as nothing (`?? 0`).
2. **This runner** (`src/sessionUsage.js`, after step 1 is deployed): send
   `cost_usd: null` when `missing` is non-empty.
3. **Backfill:** rows recorded for `claude-opus-5-5` before its price landed
   (2026-11-20) still say `0`. Their `usage_by_model` holds the tokens, so re-cost them
   from `claude_model_pricing`. One SQL update or a one-off script will do it.

_GitHub issue #22 — end the commit subject with `(#22)`._
