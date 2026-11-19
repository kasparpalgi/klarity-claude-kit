> Run with: Opus 5.5 / high
> Machine: mac

# doesn't pick todo tasks the runner

## Original Requirement

[NEVER REMOVE]

just created [kasparpalgiEzyspaceLandingBlob-TODO.md](https://github.com/kasparpalgi/klarity-claude-kit/blob/main/doc/todo/017-kasparpalgiEzyspaceLandingBlob-TODO.md) and it didn't start

_From Kanban card `7369f93e-c239-4634-8c07-0069b0f6a416`, moved to the agent list._

_GitHub issue #18 — end the commit subject with `(#18)`._

## Results

**Summary** — 017 did not start because it is addressed to `windows`, and the windows runner has
run nothing since 11:36. It hit the 5-hour usage limit then (`waiting out usage limit until
19/11/2026, 16:21 EET` every tick). Windows keeps its cards at the limit on purpose (`handOver`
is off, as the runner README says), so 017 waits and starts by itself after 16:21.

Windows used up its limit by running ezyspace-landing's 018 at the same moment as karel. At
11:20:10 karel won the card's claim, and windows pushed `chore(todo): claim 018 for windows`
in the same second. Windows' runner `config.json` still holds the pre-#246 Hasura settings and
**no `apiToken`**. Without a token it claims through git, and karel never looks there. Both ran
the task at Opus 5.5 / max on one Claude account (both waited for the same reset, 4:20pm), so
both hit the limit by 11:40.

This file then got stuck on the mac. The cause was in the runner, not in this task. 019 has
the details and the fix.

**Built (runner 0.38.3)** — the runner logs `kanban: OFF — no apiToken: …` when it starts and
in `--check`, so a runner without a token shows up. The runner README now says every runner
needs `apiToken`.

**What you need to do**
1. Add `apiToken` (the Kanban's `RUNNER_API_TOKEN`, the same value karel has) to windows'
   runner config: in WSL, `~/Documents/GitHub/klarity-claude-kit/plugins/dev-kit/runner/config.json`,
   then `systemctl --user restart kanban-runner`. The project rules say never to copy that
   file's secrets, so I left it to you. Until it is there, any Auto task can run twice when
   windows and another runner pick it in the same tick.
2. Nothing for 017 itself: it starts on windows after 16:21. To have it sooner, point its card
   at a machine on another account (dell's limit resets at 15:51).

**Files changed** — runner `src/config.js`, `src/run.js`, `src/usage.js`, `test/apiError.test.js`
(new), `README.md`, `package.json` 0.38.2 → 0.38.3 (one commit with 019); this file, renamed
`-BLOCKED`.

**Verification** — windows' and karel's runner journals, the `git log` of both machines'
ezyspace-landing clones, and both configs' keys (values not read). `npm test` 249/249 on WSL.

**Deviations** — Finished by `019-unstick018` in a Windows session, because the mac that holds
this file's log could not be reached.
