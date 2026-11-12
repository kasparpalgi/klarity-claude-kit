> Run with: Sonnet 5.5 / medium

# Runner alerts are lost: Pushbullet answers `pushbullet_pro_required`

## Original Requirement

[NEVER REMOVE]

> Run with: Sonnet 5.5 / medium

# Runner alerts are lost: Pushbullet answers `pushbullet_pro_required`

## Original Requirement

\[NEVER REMOVE\]

Split out of task 002 (karel did not pick up tektok-app 497). Since 2026-10-17 every Pushbullet push from karel and servo/dell fails with `400 pushbullet_pro_required — Pushbullet Pro is required to make this call` (927 failures on karel in 30 days). So the runner's one signal for a wedged repo — **⛔ blocked** — never reached the phone, and tektok-app sat diverged on karel for three days with nobody told.

Decide and do one:

1. Pay for Pushbullet Pro (a person's decision — no code), or
2. Move `src/notify.js` to a free channel (e.g. ntfy.sh, a topic per user, token in `config.json`, documented in `config.example.json` and `runner/README.md`). --- yyees free please

Either way: a notify that fails should not be silent beyond the log — e.g. put the blocked reason on the affected task's card status line as well, so the board shows why a card in the agent list is not moving.

*GitHub issue #3 — end the commit subject with* `(#3)`*.*

_From Kanban card `efea4099-5bfd-4537-9106-f975c30c44d0`, moved to the agent list._

_GitHub issue #3 — end the commit subject with `(#3)`._

## Results

**Summary** — `src/notify.js` now posts to ntfy.sh (free) instead of Pushbullet: `NTFY_TOPIC` enables it, optional `NTFY_SERVER` / `NTFY_TOKEN`; no topic = silent no-op; failures still logged. Config is via environment (like the old token), not `config.json`, because `notify` has no config access. Putting the blocked reason on the task card is split out as follow-up `005-blockedReasonOnCard.md` (Backlog).
**Files changed** — modified `runner/src/notify.js`, `runner/README.md`, `runner/package.json` (0.34.0), `runner/test/smoke.test.js`, `runner/test/cloud.test.js`; created `doc/todo/005-blockedReasonOnCard.md`.
**Verification** — `npm test`: 235 pass, 2 fail (`sweep` worktree tests); the same 2 fail on the untouched tree, so not caused by this change. Not sent live: set `NTFY_TOPIC` on each machine and subscribe in the ntfy app.
**Deviations** — Card-status part deferred (follow-up); token configured by env, not `config.json`.
