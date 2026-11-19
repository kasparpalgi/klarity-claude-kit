> Run with: Opus 5.5 / xhigh
> Machine: windows

# kasparpalgi/ezyspace-landing/blob/main/.claude/todo/018-016Followup-TODO.md

## Original Requirement

[NEVER REMOVE]

Moved to TODO list and run out of usage so moved back to Backlog, updated not to create subagents but followuop tasks, changed machine to dell servo and again to TODO but doesn't trigger. Make sure it removes TODO from the file name when going away from TODO list and adds again when added back. Or maybe some other issue why doesn't trigger.

_From Kanban card `19ba5c66-59ab-437a-8764-63d82f4a8317`, moved to the agent list._

_GitHub issue #17 — end the commit subject with `(#17)`._

## Results

**Summary** — The rename works both ways. In ezyspace-landing, moving the card to Backlog at
12:07:13 renamed `018-016Followup-TODO.md` to `018-016Followup.md` (`5812297`, "back to draft").
Moving it back at 12:08:13 wrote `-TODO.md` again, with `> Machine: dell` (`a60660b`). 018
stopped for other reasons:

1. Dell was at its usage limit until 15:51. With `handOver` on, 28 s later it dropped the
   `> Machine: dell` line and put the card on Auto (`18b9066`).
2. The Mac claimed it. The Mac shares the Claude account with karel and windows, which were at
   the limit until 16:21. Both runs ended after seconds, and runner 0.38.2 counted them as
   failures. The card said `✘ Failed on mac 12:10–12:11 · attempt 2 · exit 1`. The Mac parked
   018 as stuck and filed fixer `230-unstick018-TODO.md`, pinned to itself. That fixer failed
   the same way. The limit misread is fixed in 0.38.3 (#18/#19).
3. **The dead lock, not fixed before this.** The Mac kept 018's card claimed after it gave up on
   it, then dropped off the network. Karel was free from 16:21, but its journal shows
   `skip … 018-016Followup-TODO.md claimed by another machine` at 16:21 and 16:31. Nothing would
   ever have run it. A `releaseCard` for `mac` returned `released: true`, which confirms the Mac
   was the holder.

Another problem turned up on the way. At 12:07:58 karel's sweep landed the half-finished 11:20
run's task-folder edits on ezyspace's main as `018-016Followup bookkeeping (runner)`. It treated
"card left the list" like "finished". That put a false "Done in 018: … renamed to
`OFF_MENU_SUBPAGES`, noindex gone" note into `017-wireBusinessGoPublic.md`, while main still has
`UNLISTED_SUBPAGES` and `noindex`.

**Built (runner 0.38.4)**
- When a runner gives up on an **Auto** task, it files an Auto fixer and then releases the card.
  Without the release, a runner that goes offline holds the task forever. An addressed task
  keeps a fixer pinned to its machine, as before.
- A task waits while its fixer is queued (`fixerOf`), so the task and its fixer never run at the
  same time.
- The sweep no longer lands a worktree whose card left the agent list. Its commits and its
  uncommitted changes go to a stash, as when a card leaves mid-run. `unpush` now resets to the
  commit where the run started from origin. Before, it reset only when origin had not moved,
  and in the sweep origin always has moved, because the draft rename is a new commit.

**Done in ezyspace-landing** (`8ee93f0`) — 018 got `> Machine: karel`, with its card claim moved
from mac to karel. **Karel started it at 16:37**, on the next tick. Dell, the machine you picked, does not answer ssh from here or from karel.
Auto is unsafe while windows has no `apiToken` (see 018-doesnTPickTodo). Fixer 230 is closed as
`-DONE` with its Results. The false note in 017 is removed. This machine's leftover 018 worktree
was put in a stash, so its old edits cannot land later. The 11:20 runs' work is in the
`018-016Followup` stashes on karel and windows, if you want any of it.

**Follow-up (Backlog)** — `021-claimPinsOnRequeue.md`. The Kanban keeps a runner's claim in the
card's machine field, and moving the card back to TODO writes it as `> Machine: <that runner>`.
So a round trip re-queues an Auto task pinned to its last claimer.

**Still yours** — `apiToken` in windows' runner config (from 018). Check why the Mac and dell
don't answer on 192.168.0.110, 192.168.0.111 and 84.50.53.83.

**Files changed** — modified runner `src/unstick.js`, `src/run.js`, `src/sweep.js`, `src/leave.js`,
`test/unstick.test.js`, `test/land.test.js`, `test/leave.test.js`, `README.md` (Guards: stuck task,
worktree left behind), `package.json` 0.38.3 → 0.38.4. Created `doc/todo/021-claimPinsOnRequeue.md`.
This file. In ezyspace-landing, `.claude/todo/{018-016Followup-TODO,017-wireBusinessGoPublic,230-unstick018-DONE}.md`.

**Verification** — `npm test` on WSL: 254/254 pass, 5 of them new. `node --check` passes on the 4
changed modules. `claude plugin validate ./plugins/dev-kit` passes. The diagnosis comes from
ezyspace's git log, karel's runner journal, card 018's status comments and claim, and both
runners' `state.json`. A scan of every watched repo found no other queued fixer.

**Deviations** — 018 runs on karel, not dell, because dell is unreachable. Not fixed here: the
Kanban side of the round trip (021), and the Mac's and dell's network.
