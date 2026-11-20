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
