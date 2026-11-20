> Run with: Sonnet 5 / medium

# The Kanban's unqueue clears a runner's claim the runner never saw leave

## Original Requirement

[NEVER REMOVE]

Follow-up of klarity-claude-kit#20. A runner now releases its claim on an Auto card
(`releaseCard`) when it sees the card leave the agent list: mid-run (`run.js`) or when the
worktree sweep puts the task's tree away (`sweep.js`). It cannot see a card leave when it
holds neither a run nor a worktree for it — a failed run whose worktree already closed, say.
Moving such a card to Backlog and back still writes `> Machine: <last claimer>` into the
new `-TODO.md` (`ensureMachine`). The same happens when a person moves the card back
before the runner's next poll.

In svelte-todo-kanban's `unqueue` (`src/lib/server/unqueue.ts`): when the `-TODO.md` it
renames to a draft has no `> Machine:` line and the card's `agent_machine` is set, that
value is a runner's claim, not a person's choice — clear it in the same step. Test the
Backlog-and-back round trip there; keep the runner-side release as the second guard.

_GitHub issue #23 — end the commit subject with `(#23)`._
