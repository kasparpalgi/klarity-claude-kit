> Run with: Sonnet 5.5 / medium

# Show a repo's blocked reason on each waiting task's card

Split out of task 003. A failed notify should not be the only trace of a wedged repo: when
`announceWaiting` (`runner/src/run.js`) finds tasks waiting behind a block, also write the
block reason to each task card's status comment (`status.js` — add a `waiting` kind to
`KINDS`; avoid `openStatus`'s initial "running" line flashing first). Document in `runner/README.md`.

_GitHub issue #5 — end the commit subject with `(#5)`._

_From Kanban card `49230ea2-fffe-4603-a244-e80a9aa02307`, moved to the agent list._

## Results

**Summary** — `announceWaiting` now also writes `⏳ Waiting on <machine> since HH:MM · repo blocked: <first line of reason>` to each waiting task's card, once per task. `waitingOnOrigin` returns `{ name, card }`; `openStatus` takes `first`/`note` so the "running" line never flashes; the existing `waiting` kind now reads "since" (open-ended); attempt is omitted when unset.
**Files changed** — runner `src/run.js`, `src/status.js`, `src/waiting.js`, `test/waiting.test.js`, `README.md`, `package.json` (0.35.0).
**Verification** — `npm test`: 235 pass, 2 fail (worktree-sweep tests; fail identically on the untouched tree).
**Deviations** — `waiting` kind already existed (usage wall), so it was reused.
