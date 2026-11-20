> Run with: Opus 5.5 / high
> Machine: mac (the stuck run's log is here)

# Unstick task 018

## Original Requirement

[NEVER REMOVE]

The runner ran `doc/todo/018-doesnTPickTodo-TODO.md` twice and neither run renamed it to -DONE or
-BLOCKED, so it is skipped now and its card waits in TODO.

Find out why: read that run's transcript `/Users/klarity/Documents/GitHub/klarity-claude-kit/doc/todo/018-doesnTPickTodo.log` and the work it
left (`git stash list` — the runner parks a dirty run's work there). Then finish the
task itself: do what is left, append its `## Results` and rename it -DONE.md — or,
when a person must act, say exactly what and rename it -BLOCKED.md. If the cause is in
the runner or the /todo skill rather than the task, say so in this file's Results.

## Results

**Summary** — Why 018 got stuck: both of the mac's runs, at 12:33 and 12:34, failed with `exit 1`
after eight seconds. The card's status line says `✘ Failed on mac 12:34–12:34 · … · exit 1`.
Their usage rows in the Kanban hold a single reply each, from model `<synthetic>` with 0 tokens.
Claude Code writes such a reply itself when the API answers with an error. The mac had ended
every session this way since 12:09: ezyspace-landing's 018 twice, its fixer `230-unstick018`
twice, then this repo's 018 twice. Two more rows, at 12:37 and 12:38, are probably this file's
own runs. karel and windows hit the 5-hour limit on one account at 11:36–11:40. On karel, such a
reply reads `You've hit your 5-hour limit · resets 4:20pm (Europe/Tallinn)`, with
`error: "rate_limit"`. So the mac most likely shares that account and hit the same limit. The
runner read no limit from the pane, so it counted both runs as failed attempts, parked 018 as
stuck, and filed this fixer.

**The cause is in the runner**, not in the task or the /todo skill. The runner looked for the
usage limit only in the pane text, and an error a session ended on was never shown anywhere.

**Built (runner 0.38.3)**
- `lastApiError` (`src/usage.js`) reads the API error a session ended on from its transcript,
  and `run.js` looks there for the usage limit as well as in the pane. A limit found there now
  starts the cooldown and gives the attempt back, so it no longer counts toward stuck.
- Any other API error a run ends on goes into the card's `✘` line, the log and the retry note
  (`exit 1 — API error: …`).
- The `kanban: OFF — no apiToken` line, and 018's diagnosis. 018 now has its Results and is
  renamed `-BLOCKED`, because the windows `apiToken` is yours to add.
- Filed `020-unpricedCostShowsZero.md` for the Backlog. With no price row for
  `claude-opus-5-5` yet, every Opus 5.5 card shows `$0.00`.

**Could not do** — read `doc/todo/018-doesnTPickTodo.log` and `git stash list` on the mac. Its
LAN address (192.168.0.110) no longer answers. Over tailscale (`kaspar-mac-mini`, 100.68.52.4)
it answers ping but not ssh. A run that ends with `exit 1` stashes only if it left files
changed, and the card does not say "parked", so 018 most likely has no stash. To confirm the
cause on the mac:
`grep -i limit ~/Documents/GitHub/klarity-claude-kit/doc/todo/018-doesnTPickTodo.log`.

ezyspace-landing's 018 and its fixer 230 are most likely parked as stuck on the mac in the same
way. That is 017's subject, and 017 runs on windows after 16:21. Editing a task file resets its
attempt count.

**Files changed** — modified `plugins/dev-kit/runner/src/{usage,run,config}.js`,
`plugins/dev-kit/runner/README.md` (Usage limits, claims), `plugins/dev-kit/runner/package.json`
0.38.2 → 0.38.3; created `plugins/dev-kit/runner/test/apiError.test.js`,
`doc/todo/020-unpricedCostShowsZero.md`; renamed `018-doesnTPickTodo-BLOCKED.md` with its
Results; this file.

**Verification** — `npm test` in WSL: 249/249 pass, 4 of them new. Native Windows fails 36
tests before this change and 35 after it, because there is no `gh` and the herdr fakes are
POSIX-only. The `kanban:` line was checked both ways, and `node --check src/run.js` passes.
`claude plugin validate` was not needed: no skill, hook or manifest changed. The diagnosis came
from the journals on windows and karel, card 018's status comment, the Kanban `usage` rows, and
karel's transcripts.

**Deviations** — Run from a Windows session, not the mac this file names, because the mac was
unreachable. So the transcript and the stash were read only indirectly, as described above.
