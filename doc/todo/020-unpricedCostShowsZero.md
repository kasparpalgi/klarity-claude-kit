> Run with: Sonnet 5 / medium

# An unpriced model shows as $0.00 on the card

## Original Requirement

[NEVER REMOVE]

Filed by `019-unstick018`. The Kanban's price list has no row for `claude-opus-5-5` yet, so
`recordUsage` logs `→ $0.0000 (no price for claude-opus-5-5, …)` and the card's status line says
`$0.00` for every Opus 5.5 run. That includes karel's 20-minute, 8.1M-token ezyspace-landing run.
`$0.00` reads as "nothing was spent", which misled the diagnosis of 018.

When a run's model has no price, show the cost as unknown on the card (or leave it out) instead
of 0, and keep `cost_usd` from claiming 0 in the `claude_usage` row. Also check that the pricing
job picks up `claude-opus-5-5` once LiteLLM lists it.

_GitHub issue #19 — end the commit subject with `(#19)`._
