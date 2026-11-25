> Run with: Opus 5.5 / high

# A session paused at the usage wall resumes by itself and doubles a handed-over task

## Original Requirement

[NEVER REMOVE]

From a session in ezysmart-web (2026-11-25): "I can see in karel same task is running... why same task is
picked in both places???? stop the process that is behind", then "karel already completed this task so better
check klarity-claude-kit repo and fix why 2 machines picked the same todo task!!!"

## Results

**What happened** (servo's `journalctl --user -u kanban-runner`, ezysmart-web 100):
- 18:22:41 servo claimed 100 and started a pane; 18:22:48 the run hit the 5-hour wall. Claude Code (2.1.332)
  then keeps the session alive, "continuing automatically at 6:40pm", and herdr reports the pane idle.
- 18:23:45 `handOver` (`src/handover.js`, `handOver: true`) found no live pane (`paneLive` counts only
  working / blocked), released the card, parked and closed the worktree: "handed 100 to any free runner".
- 18:26 karel claimed the card and started 100. 18:40 servo's session resumed on its own in the removed
  worktree, recreated it and worked on the same card. Stopping karel's copy then made its runner finish
  100 as `-DONE` with nothing done ("tree was clean") and close the issue.

**Summary**
- `src/herdr.js` `closePane(name)`: closes every tab with that label, whatever its agent is doing.
- `src/run.js`: when a run's output or transcript shows the usage wall, the runner closes that run's pane
  (with herdr), so the session cannot come back by itself. The retry stays the runner's: after the reset
  from the kept worktree, or on a free runner through the hand-over. Before Claude Code's auto-continue, a
  walled session simply stopped, which is what the cooldown, the given-back attempt and the hand-over assume.
- `runner/README.md` *Usage limits*: the paragraph on it. Runner 0.39.5.

**Files changed**: `plugins/dev-kit/runner/src/herdr.js`, `src/run.js`, `test/herdr.test.js`, `README.md`,
`package.json`; this file.

**Verification**
- [x] `npm test`: 263/263 (new: `closePane ends the named tab even while its agent waits or works (#25)`).
- [ ] Next usage wall on a herdr runner: the log shows `⏳ … usage limit`, the `task-N` tab is gone, and no
      session resumes at the reset (watch with `herdr tab list`).

**Deviations**: None.
