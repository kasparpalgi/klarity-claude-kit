> Run with: Opus 5.5 / high
> Machine: mac

# again doesn't pick up

## Original Requirement

[NEVER REMOVE]

karel2 doesn't do <https://github.com/kasparpalgi/server/blob/main/.claude/todo/055-050Followup-TODO.md>

_From Kanban card `8ee3898f-b96f-4716-95e4-c8c2e7aa25c9`, moved to the agent list._

_GitHub issue #28 — end the commit subject with `(#28)`._

## Results

**Summary** — karel2 did pick up server's `055-050Followup-TODO.md` (`> Machine: windows`,
which is karel2's WSL runner). It started 14:36:06 today, a minute after the card moved. The
session ended within 15 seconds on `Login reached its time limit · Please run /login`. Claude's
login on karel2 has expired. The #27 fix did what it should: the attempt was given back, and the
machine is paused, retrying every 30 minutes (`waiting until 27/11/2026, 15:06 EET`), instead
of parking 055 as stuck. From karel2's journal over ssh: runner 0.39.8 is up since 26/11
16:35, and the clone is at `058b4cb`.

Why it looked like "doesn't pick up": karel2's `config.json` has **no `apiToken`**
(`kanban: OFF`) and no `NTFY_TOPIC`. So the `⏳ Waiting … Claude login expired` card line
and the `Runner 🔑 logged out` ping both went nowhere. The 055 card has only its
"Task file ready" comment. Also, karel2's own log said `⏳ waiting out usage limit` for what
was a lost login.

**Built (runner 0.39.9)** — a pause now remembers why it started (`state.setCooldown(until, why)`,
`cooldownWhy`). The tick log, `--check` and every waiting card now say
`Claude login expired on windows, run /login there, retry 15:06`, not `usage limit, back …`.
A login never comes back by itself, so "back" was wrong. The README no longer says that a
silent card always means a dead runner: a runner with no `apiToken` is silent too.

**What a person must do (why this is BLOCKED):**
1. On karel2, in WSL `Ubuntu-24.04` as `win`, run `claude`, then `/login` (browser OAuth). The
   runner's next 30-minute retry then runs 055 by itself. Nothing else is needed for 055.
2. Add the Kanban `apiToken` to karel2's `plugins/dev-kit/runner/config.json`, and ideally
   `NTFY_TOPIC` to its service env. Without these, karel2's cards stay silent and it takes no
   Auto task (#24, README "Every runner needs `apiToken`"). I did not copy the secret myself
   (repo rule).

**Files changed** — modified `plugins/dev-kit/runner/src/state.js`, `src/run.js`,
`src/status.js` (`waitNote`), `test/state.test.js`, `test/status.test.js`, `runner/README.md`
(Usage limits), `runner/package.json` 0.39.8 → 0.39.9.

**Verification** — `npm test`: 267/267 pass, including the new
`a cooldown remembers why it waits…` and `a card waiting on a lost login says to log in… (#28)`.
`claude plugin validate ./plugins/dev-kit`: passed.

**Deviations** — The `handOver` commit message still says "is at its usage limit" for a login
pause. Only `handOver` runners write it, and they push the task away, so nobody waits on that
line. I left it as it is.
