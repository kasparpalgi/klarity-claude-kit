> Run with: Opus 5.5 / high
> Machine: mac

# 028

## Original Requirement

[NEVER REMOVE]

see 028 - I have updated the karel2 login

_From Kanban card `7507ec40-6d7f-4646-b9a2-dbf38d5121dd`, moved to the agent list._

_GitHub issue #29 — end the commit subject with `(#29)`._

## Results

**Summary** — The new login did not reach the runner. karel2's journal at 19:13 EET: the
runner started `kasparpalgi/server 055-050Followup-TODO.md` again, and 6 seconds later it was
`Claude login expired on windows, run /login there … waiting until 19:43`. The session log says
`Login reached its time limit · Please run /login`. The runner (WSL `Ubuntu-24.04`, user `win`,
`/home/win/.local/bin/claude` 2.1.332) reads `/home/win/.claude/.credentials.json`. That file
was last written at **14:36**, the time of the first failure, and still has
`loginEnded: time_limit`. `~/.claude/history.jsonl` there has no `/login`, only the runner's
half-hourly `/todo 055`. No other account has a Claude credentials file: not root, not the
`immich` distro, and no `C:\Users\*\.claude`. So the `/login` was done somewhere the runner
does not look, or it never finished. (`config.json` still has no `apiToken` either, so the
055 card stays silent.)

**Built (runner 0.39.10)** — the login pause now names the OS account:
`Claude login expired on windows as win, run /login there`, and the ping says
"…on that machine, as that user". README "Usage limits" says a `/login` in Windows itself, or
as another WSL user, writes a different credentials file.

**What a person must do (why this is BLOCKED):** on karel2, open the **Ubuntu-24.04** WSL
shell as **`win`** (`wsl -d Ubuntu-24.04 -u win`), run `claude`, then `/login`, and finish
the browser step. To check it worked: `ls -l ~/.claude/.credentials.json` shows a time after
the login. The next 30-minute retry then runs 055 with nothing else to do. Optional, from
#28: add `apiToken` to that clone's `runner/config.json` so its cards report progress.

**Files changed** — modified `plugins/dev-kit/runner/src/run.js`, `runner/README.md`,
`runner/package.json` 0.39.9 → 0.39.10.

**Verification** — `npm test`: 267/267 pass. `claude plugin validate ./plugins/dev-kit`:
passed. Prettier: clean.

**Deviations** — I did not copy the Mac's OAuth tokens to karel2. That would move a secret
between machines, and a refresh token rotated on one machine would log the other one out.
