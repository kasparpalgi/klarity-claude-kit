> Run with: Opus 5.5 / medium
> Machine: mac

# why doesn't pick up

## Original Requirement

[NEVER REMOVE]

is not picked up: <https://github.com/kasparpalgi/svelte-todo-kanban/blob/main/.claude/todo/267-seeTheLastTodo-TODO.md>

_From Kanban card `76a13a38-a2b4-4d7c-8973-7e92ffbe0ed5`, moved to the agent list._

_GitHub issue #26 — end the commit subject with `(#26)`._

## Results

**Summary** — Why svelte-todo-kanban's `267-seeTheLastTodo-TODO.md` is not picked up: it
carries `> Machine: windows`, so only the Windows runner may take it. The Mac's `--check`
shows `267-seeTheLastTodo-TODO.md [→ windows, not this machine]`, which is correct. Nothing
on the Mac or on the file is wrong. windows shares karel's Claude account and so its usage
wall, and karel logged that wall at 21:11 EET today, `until 26/11/2026, 01:25 EET` (the
`chore(todo): hand 262 to any runner` commit). windows runs without `handOver`, as the
README says it should, so it keeps the task until that reset. The other possibility is
that the Windows runner is not running at all. I can't check that from this Mac.

The real bug was that nothing on the card showed any of this. A walled runner with
`handOver` off returned from its tick before visiting any repo. Its waiting cards said
nothing, so they read as "not picked up". Now such a runner still ticks each repo while
walled. Each task that names it gets one `⏳ Waiting on windows since … · usage limit,
back …` status comment per reset. The run later takes over that comment as `▶ Running`.

**What a person should check:** if 267 has not started after 01:25 EET on 26/11, or its
card gets no `⏳ Waiting` line once windows pulls 0.39.7, the Windows runner is down. Restart
it on the PC, or move the card to Auto or another machine.

**Files changed** — modified `plugins/dev-kit/runner/src/status.js` (`sayWalled`),
`src/run.js` (the tick and the walled branch), `test/status.test.js`, `runner/README.md`
(Usage limits), and `runner/package.json` 0.39.6 → 0.39.7.

**Verification** — `npm test`: 264/264 pass, including the new
`a walled runner that keeps its tasks says so on each card, once per reset (#26)`.
`npm run check` on the Mac lists 267 as `[→ windows, not this machine]`.

**Deviations** — None. The diagnosis needed a small fix so the next waiting card explains itself.
