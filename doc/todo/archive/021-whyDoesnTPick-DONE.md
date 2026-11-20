> Run with: Opus 5.5 / high
> Machine: dell

# why doesn't pick up AGAIN???

## Original Requirement

[NEVER REMOVE]

kasparpalgi/ezyspace-landing/blob/main/.claude/todo/[020-wireCertificatesQuality-TODO.md](http://020-wireCertificatesQuality-TODO.md)

_From Kanban card `cfe014eb-7611-4dc7-9939-16fc8247d0c4`, moved to the agent list._

_GitHub issue #21 — end the commit subject with `(#21)`._

## Results

**Summary** — ezyspace-landing's `020-wireCertificatesQuality-TODO.md` did not start because its
second line is `> After: #19`. #19 was `019-wireSmallCompetitors.md`, a suffixless Backlog draft
that the 018 session filed with the same commit. A Backlog draft never runs by itself, so #19
stayed open and every runner skipped 020 on every tick. Nothing showed that it was waiting:
no log line and no card comment.

On the owner's word ("kill that 19"), 019 is dropped. It was renamed
`019-wireSmallCompetitors-DONE.md` with a "dropped, never run" Results (ezyspace-landing
`56c54f8`), issue #19 was closed as not planned, and 022's `> After:` no longer lists #19. 020 is
Auto at Opus 5.5 / xhigh, and the next free runner picks it up within a minute or two. It runs
without 019's small-player list, which its own Context section expected.

019 was not what used up today's usage. It never ran on any machine, because a suffixless
file is never queued. Dell's only big run today was ezyspace-landing 018 at **Opus 5.5 / max**
(10:50). The same task also ran on karel and windows (see 018/019 in this folder).

**Built (runner 0.39.1)** — `announceAfter` (`src/run.js`). When a task is held by
`> After: #N`, the runner says so once per file version. Its card gets
`⏳ Waiting on <machine> · waits for #N to close or merge (> After: #N)` (the same comment
the run later turns into `▶ Running`), and the log gets the same line. There is no
notification, because every runner that may take an Auto task would send one. The runner
README's `> After:` paragraph now says this, and that a Backlog draft never closes on its own.

**Files changed** — modified `plugins/dev-kit/runner/src/run.js`, `plugins/dev-kit/runner/README.md`,
`plugins/dev-kit/runner/package.json` (0.39.0 → 0.39.1); this file, renamed `-DONE`. In
ezyspace-landing: `019-wireSmallCompetitors.md` → `-DONE.md`, `022-wireCopyEstonian.md`'s After line.

**Verification** — `npm test` 255/255 and `node --check src/run.js` pass. The diagnosis comes from
dell's runner journal, `gh issue view 19` (open before, closed now) and `waiting()` in `src/pr.js`.
`announceAfter` has no unit test, because `run.js` has no test harness. Its first live line
shows up on the next held task.

**Deviations** — Dropping 019 was the owner's call, made mid-run. It was not part of the card.

**Addendum (20:40)** — Reversed on the owner's word: "19 shall run first". Issue #19 is reopened,
and ezyspace-landing `3444f40` reverts the drop and queues `019-wireSmallCompetitors-TODO.md`
(its card moved to TODO). By then mac had started 020 at 20:36. Its file went back to a draft
and its card to Backlog, with mac's claim released, so mac stopped it at 20:40 and nothing
landed. Move 020's card back to TODO once 019 lands. 022 still waits on #19, #20 and #21.
