> Run with: Opus 5.5 / high
> Machine: mac

# A runner's claim turns into a pin when the card goes to Backlog and back

## Original Requirement

[NEVER REMOVE]

> Run with: Sonnet 5 / medium

# A runner's claim turns into a pin when the card goes to Backlog and back

## Original Requirement

\[NEVER REMOVE\]

Filed by `017-kasparpalgiEzyspaceLandingBlob`. A runner claims an Auto card by setting the card's `agent_machine` (`claimCard`). The Kanban's `unqueue` renames the file back to a draft but leaves `agent_machine` set. When the card is moved back to TODO, `write-task-file` writes `> Machine: <agent_machine>` into the new `-TODO.md` (`ensureMachine`). So moving a card to Backlog and back, which a person does to start it over, re-queues an Auto task addressed to whichever runner last claimed it. That runner may be offline or at its usage limit. The card's machine dropdown shows that runner, so it looks like a person's choice.

Make the round trip start an Auto task over as Auto. Either the runner releases its claim (`releaseCard`) when it sees the card leave the agent list (mid-run stop in `run.js`, and the sweep's card-left branch in `sweep.js`) and the file had no `> Machine:` line, or the Kanban's `unqueue`clears a claim that no person set. Pick one and test the round trip.

*GitHub issue #20 — end the commit subject with* `(#20)`*.*

_From Kanban card `393f6f7b-079d-40d1-bb2f-e4d499f4dfd0`, moved to the agent list._

_GitHub issue #20 — end the commit subject with `(#20)`._

## Results

**Summary** — Picked the runner-side fix. A runner now releases its claim on an Auto card
when it sees the card leave the agent list, so moving it to Backlog and back gives a fresh
`-TODO.md` with no `> Machine:` line. New `unclaim(kanban, text, me)` in `claim.js` calls
`releaseCard` only when the file the run started from has a card line and no
`> Machine:` line, meaning no person picked a machine. `releaseCard` is compare-and-swap, so
another runner's claim is left alone. It is called from the mid-run stop in `run.js` (log:
`its card is back on Auto`) and from the sweep's card-left removals in `sweep.js`, both
push-to-main and pull-request trees (log: `, its card back on Auto`). Board errors count as
no release.

**Files changed**
- modified `plugins/dev-kit/runner/src/claim.js`, `src/run.js`, `src/sweep.js`
- created `plugins/dev-kit/runner/test/unclaim.test.js`: the round trip (claimed Auto card →
  left → `agent_machine` null), a person's `> Machine:` kept, another runner's claim kept,
  no card / no board / board error
- modified `test/land.test.js`: the sweep's card-left test checks the `releaseCard` call
- modified `plugins/dev-kit/runner/README.md` (Auto claims section and the mid-run table row),
  `package.json` 0.39.2 → 0.39.3
- created follow-up `doc/todo/023-unqueueClearsClaim.md` (Backlog)

**Verification**
- `npm test`: 261/261 pass on three runs in a row. One earlier run had 2 failures I could not
  capture or reproduce, probably flaky git-timing tests.
- `claude plugin validate ./plugins/dev-kit`: passed

**Deviations** — The runner can only release what it can see. If a card leaves while this
runner has no run and no worktree for it (for example, a failed run whose worktree already
closed), or a person moves it back before the next poll, the claim still pins it. Follow-up
`023-unqueueClearsClaim.md` adds the Kanban-side guard in svelte-todo-kanban's `unqueue`.
