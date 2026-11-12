> Run with: Sonnet 5.5 / medium

# Runner alerts are lost: Pushbullet answers `pushbullet_pro_required`

## Original Requirement

[NEVER REMOVE]

Split out of task 002 (karel did not pick up tektok-app 497). Since 2026-10-17 every
Pushbullet push from karel and servo/dell fails with
`400 pushbullet_pro_required — Pushbullet Pro is required to make this call` (927 failures
on karel in 30 days). So the runner's one signal for a wedged repo — **⛔ blocked** — never
reached the phone, and tektok-app sat diverged on karel for three days with nobody told.

Decide and do one:

1. Pay for Pushbullet Pro (a person's decision — no code), or
2. Move `src/notify.js` to a free channel (e.g. ntfy.sh, a topic per user, token in
   `config.json`, documented in `config.example.json` and `runner/README.md`).

Either way: a notify that fails should not be silent beyond the log — e.g. put the
blocked reason on the affected task's card status line as well, so the board shows why a
card in the agent list is not moving.
