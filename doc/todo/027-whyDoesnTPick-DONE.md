> Run with: Opus 5.5 / medium
> Machine: karel

# why doesn't pick up?

## Original Requirement

[NEVER REMOVE]

understand why and make it pick up next time in same situation kasparpalgi/job/doc/todo/[013-see012AndMove-TODO.md](http://013-see012AndMove-TODO.md)

_From Kanban card `f8a3e402-ab7a-49ea-a970-d591974a6c65`, moved to the agent list._

_GitHub issue #27 — end the commit subject with `(#27)`._

## Results

**Summary** — job's `013-see012AndMove-TODO.md` was not picked up because of two separate things.

1. **Yesterday (25/11), on karel:** 013 had no `> Machine:` line then, so karel took it. Each
   attempt ended within seconds on `Login reached its time limit · Please run /login`, because
   karel's Claude login had expired. The runner read that as the task failing. After three tries
   it parked 013 as stuck and filed `014-unstick013-TODO.md`, and 014 failed three times the same way.
   This was a runner bug, and it is now fixed.
2. **Today (26/11 16:20):** the card was moved back with `> Machine: dell`. karel's
   `npm run check` shows `013-see012AndMove-TODO.md [→ dell, not this machine]`, which is correct.
   The 16:20 edit changed the file's mtime, so the old tries count no longer applies. Dell
   takes it on its next free tick. From karel I could not check whether dell's runner is up. If 013
   has not started within a few minutes, look at dell, or put the card on Auto.

**Built (runner 0.39.8)** — `loginLost` (`src/usage.js`). An expired or missing Claude login
(`Please run /login`, `Not logged in`, `Login reached its time limit`, `OAuth token has expired`,
`Invalid API key`) is now handled like the usage wall. The runner gives the attempt back, pauses the
machine for 30 minutes (its tasks are handed over, or they wait), sends `Runner 🔑 logged out`
("Run `claude` then /login on that machine"), and the card says
`⏳ Waiting … Claude login expired on karel`. A task in the same situation is now run as soon as the
login works again, or by another machine, and is never parked as stuck. In job, `014-unstick013`
was closed as DONE with this cause (`282adfe`).

**Files changed** — modified `plugins/dev-kit/runner/src/usage.js`, `src/run.js`,
`test/usage.test.js`, `runner/README.md` (Usage limits), `runner/package.json` 0.39.7 → 0.39.8.
In job: `doc/todo/014-unstick013-TODO.md` → `-DONE.md`.

**Verification** — `npm test`: 265/265 pass, including the new
`an expired login is the machine's state, rechecked in 30 min (#27)`.

**Deviations** — The hand-over commit and the `sayWalled` card line still say "usage limit"
when the pause is a login. I left that wording to keep the change small.
