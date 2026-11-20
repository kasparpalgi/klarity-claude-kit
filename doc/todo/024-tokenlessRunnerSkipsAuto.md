> Run with: Opus 5.5 / high

# A runner without apiToken must not claim Auto tasks

## Original Requirement

[NEVER REMOVE]

Follow-up of #18. On 2026-11-20 tektok-app's 548 ran on two machines at once. The mac handed it
over at 22:28:01 (`> Machine: mac` dropped), dell won the card's claim at 22:28:17 ("claimed for
dell" in its journal), and windows pushed `chore(todo): claim 548 for windows` at 22:28:39.
Windows still has no `apiToken` (018 asked the owner to add it), so `claim()` falls back to
`pushClaim`, a lock that runners with a token never read. The `kanban: OFF` warning from 0.38.3
only logs it.

Make the double run impossible whatever the config says:

- A runner without `apiToken` takes only tasks addressed to it by `> Machine:`. It skips an Auto
  task with a card id (`_From Kanban card …_`), since it cannot take that card's lock, and says
  so once per task in its log.
- A runner with a token checks `origin`'s copy of the file just before it starts and stands down
  when a `> Machine:` line there names another runner (the pushed claim of an older or tokenless
  runner).
- Tests for both in `test/claim.test.js`.

The owner still adds `apiToken` on windows (018, step 1).

_GitHub issue #24 — end the commit subject with `(#24)`._
