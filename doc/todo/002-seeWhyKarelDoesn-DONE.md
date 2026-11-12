> Run with: Opus 5.5 / high
> Machine: dell

# See why karel doesn't pick up `tektok-app` repo's todo task

## Original Requirement

[NEVER REMOVE]

Move to TODO list on board [doc/todo/](https://github.com/mytekdok/tektok-app/blob/main/doc/todo/497-appleLoggedIn-TODO.md)[497-appleLoggedIn-TODO.md](http://497-appleLoggedIn-TODO.md) but doesn't pick the karel

_From Kanban card `cc48ef59-3ce4-4ee0-a229-3c0aa195db67`, moved to the agent list._

_GitHub issue #2 — end the commit subject with `(#2)`._

## Results

**Summary** — Root cause found, karel repaired, runner fixed. Karel's tektok-app clone
had been skipped every tick since 2026-11-09 15:20 with `main has diverged from
origin/main and will not rebase cleanly`, so 497 (and anything else for karel in that
repo) was never picked up. How it got there: at 15:19:56 karel filed the Backlog
follow-up `482-codexSecondReview.md` as issue #484, but its push failed because origin had
just moved. It still moved the card to `484-…`, which released the card lock on `482-…`.
At 15:20:18 servo swept the same commit, found no card at `482-…`, and filed it again as
#486 (that push worked). Karel's local rename 482→484 and origin's 482→486 can never
rebase onto each other. The **⛔ blocked** alert that should have flagged this was lost:
Pushbullet has been returning `pushbullet_pro_required` on both machines since 2026-10-17.

- **Repaired:** karel's clone `main` reset to `origin/main`. The dropped commit
  `01011520` only held the duplicate rename and is still in karel's reflog. Karel started
  `497-appleLoggedIn-TODO.md` at 13:12:27 (attempt 1). Duplicate issue #484 closed as a
  duplicate of #486, and its duplicate Backlog card removed. `486-codexSecondReview.md` is
  the one that stays.
- **Fixed (`src/followup.js`):** a failed push is retried after `pull --rebase`. If it
  still fails, the commit is undone (`reset --keep`), and the card keeps the old path, so
  the lock holds and nothing diverges. The card moves to the new name only after the
  rename is on origin. A runner whose clone still has the old file fetches before filing,
  and backs off if origin already renamed or removed it.
- **Follow-up:** `003-pushbulletQuota.md` (Backlog): pay for Pushbullet Pro or move
  notifications to a free channel.

**Files changed**
- modified `plugins/dev-kit/runner/src/followup.js`, `README.md`, `package.json` (0.33.0 → 0.33.1)
- modified `plugins/dev-kit/runner/test/followup.test.js` (fixtures moved out)
- created `plugins/dev-kit/runner/test/followup.fixture.js`, `test/followupPush.test.js`
- created `doc/todo/003-pushbulletQuota.md`

**Verification** — `npm test`: 237/237 pass. Both new tests fail against the old
`followup.js`, so they reproduce the incident. Checked on karel: the clone is level with
origin and the 497 run has started.

**Deviations** — Fixing karel's clone, closing #484 and removing its card went beyond
"see why", but they were what unblocked the queue.
