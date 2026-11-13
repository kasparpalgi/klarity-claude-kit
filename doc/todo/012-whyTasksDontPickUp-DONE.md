# Tasks wait for a machine at its usage limit instead of going to a free one

## Original Requirement

[NEVER REMOVE]

why tasks don't pick up? onmac session resets in 1h but it shall pick other machines then remember

_Asked in an interactive session on dell. GitHub issue #12 — end the commit subject with `(#12)`._

## Results

**Summary.** Nothing was broken. The waiting tasks were all addressed to the Mac, and no
code ever moved a task off a machine at its usage wall. The Mac hit its 5-hour wall at
21:23 during 230 and set `cooldownUntil` to 23:31 EET in its own `state.json`. Only the Mac
knew about it. Dell and karel kept skipping every `> Machine: mac` task as "not this
machine".

| Task | Card machine | Why it waited (22:30) |
| ---- | ------------ | --------------------- |
| kanban 230, 231, 234, 241 · kit 011 · boilerplate 032 | mac (bare) | the Mac is at its wall until 23:31. 230 stopped mid-run, and its main commit is already on origin |
| renlog-mets 167, ezyspace-landing 013 | `mac (reason…)` | they need the Mac: ssh to renlog, the Pi deploy |
| kanban 236 | windows (Auto, claimed) | it is running on karel2 since 21:47, so this is fine |
| kanban 206 · boilerplate 038 | karel | they belong to karel |

**Built (runner 0.37.0): a runner at its usage wall hands its queue over** (`src/handover.js`)

- With `"handOver": true`, every tick during the cooldown still preflights each repo, but
  only to give tasks away. The card's `agent_machine` is cleared to Auto (compare-and-swap,
  only while it is ours). A bare `> Machine: mac` line goes from the file in one pushed
  commit per repo. The next free runner claims each task through the existing `claim.js` path.
  The phone gets `Runner ↪ handed over`.
- It keeps three kinds of task: a `> Machine:` line with a bracketed reason, a task whose pane
  still works, and a task whose worktree holds commits that are on no remote. Other uncommitted
  work in that worktree is parked in a stash, and the worktree is closed.
- An Auto task this runner started and then walled on goes back to Auto too. Other runners
  used to remember "claimed by another machine" until their next restart. They now ask
  the card again after ten minutes.
- Cloud sends pause during the wall, since they bill the same account.
- The flag is opt-in per machine. I turned it on for mac, dell and karel. `windows` stays off,
  because the board pins one person's cards to that machine.

**Files changed**
- created `runner/src/handover.js`, `runner/test/handover.test.js`
- modified `runner/src/run.js`, `runner/src/claim.js` (`release`, `pushFiles`),
  `runner/src/machine.js` (`reasoned`, `withoutMachine`), `runner/src/config.js`,
  `runner/config.example.json`, `runner/README.md` (Usage limits, Which machine, Config,
  notifications, Files), `runner/package.json` 0.36.0 → 0.37.0

**Verification**
- `npm test`: 242 tests pass. The 3 new ones in `handover.test.js` cover a bare task,
  a reasoned task, another machine's task, a started and an unstarted Auto task, unpushed
  commits and a live pane.
- `claude plugin validate ./plugins/dev-kit` passes, and `run.js --check` runs on dell.
- `handOver: true` is set in the runner config on dell, karel and the Mac.

**Live check, 22:45–22:47.** The Mac took the update at 22:45:12. It handed over 011 at
22:46:15, 032 at 22:46:20, and 230, 231, 234 and 241 at 22:46:44. Karel claimed 011 at 22:46:47
and dell claimed 032 at 22:47:07. The kanban four go out as runners free up.

**Other stuck tasks, decided in the same session ("make all decisions for me")**
- boilerplate 038 and kanban 206 had been skipped on karel as stuck since September and
  October, before fixers existed. I filed their fixers on karel, where the logs are:
  boilerplate `096-unstick038` and kanban `249-unstick206`.
- Fixer tasks now say `> Machine: karel (the stuck run's log is here)`, so a usage wall never
  hands them away (runner 0.37.1).
- boilerplate 93 (cloud smoke test) was not stuck: its PR #94 had waited since Nov 10. It
  changed only the task file, so I merged it.
- ezysmart-web 056 named no runner. Only the Mac has `../ezyrent-be` and ezy-iot, so it is now
  `> Machine: mac (the only runner with …)`. It has no card to update.
- tektok-app `> Machine: manual` tasks stay as they are: they are for a person by design.

**Deviations.** A bare `> Machine: mac` now reads as a preference while the Mac is at its wall.
A task that truly needs the Mac must say why in brackets, or it may run elsewhere during a wall.
