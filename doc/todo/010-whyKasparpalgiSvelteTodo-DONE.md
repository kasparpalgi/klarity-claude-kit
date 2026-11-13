> Run with: Opus 5.5 / high
> Machine: dell

# why kasparpalgi/svelte-todo-kanban repo tasks don't pick up

## Original Requirement

[NEVER REMOVE]

in todo list why doesn't pick up? make them pick up. make it so that if stuck agent is made run automatically to fix

_From Kanban card `6982b2f6-5574-47f7-87f9-acdb073d6fa3`, moved to the agent list._

_GitHub issue #10 — end the commit subject with `(#10)`._

## Results

**Summary** — Nothing in svelte-todo-kanban is broken. All three tasks in its TODO list
are waiting in line for a busy machine. Each runner runs one task at a time:

| Task | `> Machine:` | Why it has not started (20:40) |
| ---- | ------------ | ------------------------------ |
| 230 `dataApiUsersAndRest`, 231 `runnerAndExtensionApi` | mac | Queued 20:03:37/56. The mac picked tektok-app `527-iosCallScreen` (Opus 5.5 / xhigh) at 20:02:36, 61 s earlier, and that is still `working` in herdr. Before that it ran 229 `dataApiCards` (18:35–19:33), which 230 needs first. 230/231 run after 527 |
| 232 `d1SchemaAndCopy` | dell | Queued 20:24, while dell ran ezysmart-web 064 (20:16–20:37). Dell then took this task, 010, by repo rotation. 232 is next |
| 206 `errors` (Doing list) | karel | Addressed to karel since October, not to dell or mac |

Checked: `journalctl` on dell, the mac's `~/Library/Logs/kanban-runner.log` and
`herdr agent list` over ssh, `run.js --check`, and the board's TODO/Doing cards with their
status comments.

**Built: the automatic fix the card asks for ("if stuck, an agent runs to fix it")**

1. **Stuck task → fixer task.** A task that ran twice without a `-DONE`/`-BLOCKED` rename
   used to be only announced (`⏭ stuck task`) and skipped, and its card sat in TODO
   until someone filed a card like this one. The skip now also files and pushes
   `NNN-unstick<N>-TODO.md` (`src/unstick.js`):
   - it runs on the same machine, which holds the stuck run's `.log`, at the task's own `> Run with:`;
   - it reads the transcript and the stash, then finishes the original task or renames it `-BLOCKED`;
   - there is one fixer per task number, and a fixer that gets stuck gets no fixer of its own, so it cannot loop.

   The fixer's line also goes into the `⏭ stuck task` notification.
2. **Tasks addressed to a machine that no runner matches.** `> Machine: mac (+ Pi deploy of
   weather-sidecar)` was slugged whole into `mac-pi-deploy-of-weather-sidecar`. No runner
   answers to that, so the task waited forever with no signal. A note in brackets is now
   dropped. This unblocks ezyspace-landing `013-precipInputsAtSource` and renlog-mets
   `167-maadEeServerSetup`, which now go to the mac.

**Still needs a person:** ezysmart-web `056-sensorDeviceSecret` says
`> Machine: one with ../ezyrent-be and ezy-iot checked out`. That names no runner, so
pick a machine on its card.

**Files changed**
- created `runner/src/unstick.js`, `runner/test/unstick.test.js`
- modified `runner/src/queue.js` (`pick` takes an `onStuck`), `runner/src/run.js`,
  `runner/src/machine.js`, `runner/test/machine.test.js`, `runner/README.md` (Guards,
  Which machine, notifications, modules), `runner/package.json` 0.35.0 → 0.36.0

**Verification**
- `npm test`: 239 tests, all pass, including 2 new ones in `unstick.test.js` and a new `machineOf` assertion.
- `run.js --check` against dell's config: 013 and 167 now show `→ mac`.

**Deviations** — The card asked "why doesn't it pick up", and the answer is "busy machines,
not a bug", so the queue itself needed no fix. I added the `> Machine:` bracket fix
because it is a real case of tasks never being picked up, found while checking.
