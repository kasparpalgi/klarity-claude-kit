> Run with: Opus 5.5 / high
> Machine: mac

# Doesn't trigger

## Original Requirement

[NEVER REMOVE]

.claude/todo/234-d1CutOver-TODO.md

_From Kanban card `5cf78a88-5666-4076-ba86-1d7cdffd3b98`, moved to the agent list._

_GitHub issue #14 — end the commit subject with `(#14)`._

## Results

**Summary** — `svelte-todo-kanban/.claude/todo/234-d1CutOver-TODO.md` did not trigger because
an agent parked it on 13 Nov (`e424706`) with `> Machine: manual (the owner picks the cut-over
moment; needs #231 and the rest of the D1 slices)`. No runner answers to `manual`, so every
runner skipped it without a word. Its card stayed in TODO on Auto, so it looked queued. The
park itself is correct, and 234 is **left as it is**: it is a production cut-over that its own
notes call "not ready". #231 is BLOCKED on your steps (set `RUNNER_API_TOKEN`, submit extension
1.3.0, queue 250), and the D1 slices 241–245 are still in the Backlog.

What was missing is that nobody said so. `--check` turned up five more tektok-app tasks parked
the same way (343, 409, 447, 474, 505). The runner now has an optional `machines` config key that
lists every runner id. A runner with that list sends one `Runner ⏸ addressed to nobody` notice
per repo for the -TODO files whose `> Machine:` names no runner. It sends it once per file
version, and editing the file re-arms it. `--check` marks those files
`[→ manual, NO runner answers to it]`. The Mac's live `config.json` now has
`"machines": ["mac", "karel", "dell", "windows"]`.

Also fixed: two `land.test.js` sweep tests failed on every Mac, `main` included. macOS's
`tmpdir()` is `/var/…`, while `git worktree list` prints `/private/var/…`, so `runnerTrees`
never matched. The test root is now resolved with `realpathSync`.

**What you can do with 234:** when #231 and 241–245 are done and you pick the moment, delete the
`> Machine: manual …` line. The task then runs on Auto. Until then, move its card to Backlog
if you don't want it sitting in TODO.

**Files changed**
- Modified: `plugins/dev-kit/runner/src/{machine,run,config}.js`, `test/machine.test.js`,
  `test/land.test.js`, `README.md`, `config.example.json`, `package.json` (0.37.1 → 0.37.2)
- Outside git: `~/Documents/GitHub/klarity-claude-kit/plugins/dev-kit/runner/config.json` (+`machines`)

**Verification**
- `npm test`: 243/243 pass. Before the test fix it was 241/243, the same on unmodified `main`.
- `claude plugin validate ./plugins/dev-kit`: passed
- `node src/run.js --check` against the live config lists 234 and the five tektok-app tasks
  as `NO runner answers to it`

**Deviations** — The card held only a path, so the work was the diagnosis plus the notice.
234 itself is not unparked: running a production cut-over with its prerequisites still
open is your call.
