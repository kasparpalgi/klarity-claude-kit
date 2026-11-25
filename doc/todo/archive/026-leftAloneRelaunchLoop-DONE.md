> **Run with:** Opus 5.5 · **Effort:** high

# A left-alone session that ends unfinished is relaunched from scratch, forever

## Original Requirement

[NEVER REMOVE]

From kasparpalgi/server todo 056, when the owner was asked the same decision questions a second time:

> come on - same todo tasks keep running on multiple machines??? check that and try to stop that madness - I just
> answered same questions and probably on another machine

---

## Findings

Not several machines at once, but one task restarted again and again:

- **server 056 (mac):** run 1 started 19:51 and asked four decisions at 19:52. After `blockedMinutes` (30) the
  wait ended and the run was "left alone" (#60), with the try given back (`addTry -1`). The pane ended at 21:02,
  with nothing in the transcript showing the answers arrived. At 21:02:04 the runner claimed the still `-TODO`
  file again as **attempt 1**, in a fresh session that asked the same questions again.
- **ezysmart-web 100 (dell → karel):** attempt 1 at 15:08, again "attempt 1" at 16:55 ($9.12 spent) and 18:22
  ($4.40), then a usage-limit hand-over and karel ran it once more. The same loop.
- The cause: a left-alone run gives its try back, so the count never reaches `pick`'s limit of 2. When its pane
  ends, nothing marks the task, and the next tick starts it again with no memory of the old session.

Related, not fixed here: on dell, server 057 ended in 14 s with the agent saying it was blocked (too early, DNS
owner unknown), without renaming the file. The runner then renamed it `-DONE` ("agent skipped the rename"). An
agent that says it stopped should end up `-BLOCKED`, not `-DONE`. That needs its own task.

## Plan

1. `recordLeftAlone`: once the pane has ended and the task file still exists as `-TODO`, park that file version
   (`addTry … 3`, like a stuck task), set the card to ⏸ Needs you, and notify. Any edit re-arms it.
2. Say whether the session had renamed the task in its worktree without anything landing it.
3. README: document the behaviour. Bump runner 0.39.5 → 0.39.6.

## Results

**Summary**
- A left-alone session that ends with its task still `-TODO` is parked until a human edits the file. It no
  longer loops as "attempt 1" in fresh sessions that lose the owner's answers.

**Files changed**
- Modified: `plugins/dev-kit/runner/src/run.js` (`parkUnfinished`, extra fields on `leftAlone` entries),
  `plugins/dev-kit/runner/README.md`, `plugins/dev-kit/runner/package.json` (0.39.6)
- Created: this file

**Verification**
- [x] `node --check src/run.js`
- [x] `npm test`: 263 pass, 0 fail
- [ ] Live: the next left-alone run that ends unfinished logs `⏸ … parked until the file is edited` (each
      machine picks it up through selfUpdate)

**Deviations**
- No unit test: `recordLeftAlone` lives inside `run.js`'s tick loop with no seam. The 057 `-DONE`-on-refusal
  bug is noted above, not fixed.
