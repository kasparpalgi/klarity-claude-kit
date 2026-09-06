---
name: todo
description: Open and execute a numbered task file from doc/todo/ — the markdown prompt+outcome log. Use when the user types /todo <number> or asks to run a numbered task.
argument-hint: '[number]'
disable-model-invocation: true
---

# Run task `$ARGUMENTS`

The `doc/todo/` folder is the prompt history: one markdown file per request, holding the
original prompt at the top and the outcome at the bottom. Never rewrite the top part.

**The rename is the state.** The runner reads the filename, not your reply: a file still
called `-TODO.md` means "not finished", so it re-runs the task, hits the same ending, and
parks it as stuck — a dead queue slot. However this run ends — you built it, it turned out
to be already done, there is nothing to build, or a human has to take over — you finish by
appending `## Results` and renaming the file (step 6). No exit skips that.

## 1. Load

Find the task folder: use `.claude/todo/` if it exists, otherwise `doc/todo/`.
Find the file whose name starts with `$ARGUMENTS` in that folder. Read it.

## 2. Classify

| The file is…                                        | Do this                                                                                                                                                                                                                 |
| --------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| A concrete, actionable task                         | Execute it (step 3 onward)                                                                                                                                                                                              |
| Planning / open questions / bigger than one session | Answer the questions in the file, then split it into new numbered task files in `doc/todo/` (next free numbers). Do a reasonable slice of real work this session. Steps 3–6 apply only to the slice you actually built. |
| Already done, obsolete, or impossible               | Do **not** just stop and explain. Skip to step 6: a `## Results` section saying what you found — naming the commit that already did it, if there is one — and the rename. |

Every task file you create starts with a frontmatter line naming the model and effort:
`> Run with: Opus 5 / high` — hard architecture; `Sonnet 5 / medium` — normal features;
`Haiku 4.5 / low` — mechanical edits. The version is honoured exactly, so `Sonnet 4.6`
runs Sonnet 4.6; effort is any of low, medium, high, xhigh, max. Size each file to one
session.

## 3. Build

- Golden rule: **simplicity is GENIUS.** Files ~100 lines, 200 max.
- Research before writing unfamiliar API code — see the `research-first` skill.
- Follow the project's own conventions skills (they auto-load from `paths`).

## 4. Simplify pass

Re-read your own diff with a cold eye. You almost certainly over-built something —
LLMs do it nearly every time. Cut it now. If context is running out, file a follow-up
task instead of leaving the complexity in.

## 5. Verify

Run `/verify` (or the `verify` skill). Only the checks that match what you changed.

## 6. Log the outcome — every exit path ends here

Append to the task file:

```markdown
## Results

**Summary** — what got built
**Files changed** — created / modified / deleted
**Verification** — status of each check
**Deviations** — changes from the plan, or "None"
```

**Never skip this step**, including on the exits that do not feel like finishing:

| How the run ended                    | Rename to  | Results says                                          |
| ------------------------------------ | ---------- | ----------------------------------------------------- |
| You built it                         | `-DONE.md` | what you built                                        |
| It was already done before you began | `-DONE.md` | "already complete in `<commit>`", and what you checked |
| Nothing left to build / obsolete     | `-DONE.md` | why there is nothing to do                            |
| A human must decide or act           | `-TODO.md` | what you did, what is blocked, what you need          |

If context is running low, write a minimal Results section
(Summary + Files changed) *first* and fill in Verification afterwards — a short Results
beats none. The runner also saves the full session transcript next to the task file as
`NNN-slug.log`, but that is a debugging aid, not a substitute for Results.

Then rename the file to describe itself:
`008-aiWorkflow-DONE.md` (complete) or `008-aiWorkflow-TODO.md` (needs a human).

Bump `package.json` version — PATCH for fixes, MINOR for features.

## 7. Ship

Only when verification is green:

```bash
git pull && git add -A && git commit -m "<conventional commit subject>" && git push origin main
```

Respect the project `CLAUDE.md`: if it says not to commit, stop after step 6 and report.
Commit on the repo's base branch unless its `CLAUDE.md` asks for a task branch — the
runner pushes a task branch and hands it back to a human instead of continuing.

## 8. Self-check before you claim success

Prose in step 6 is not enough — runs have ended with the task file edited, unrenamed and
uncommitted, which makes the runner pick the same number again forever. Verify all three,
in the repo you worked in:

```bash
ls <task-dir>/$ARGUMENTS-*            # exactly one file, ending -DONE.md or -TODO.md
git status --porcelain                # empty
git log --oneline -1                  # your commit
```

- The task file is renamed (`-DONE.md`, or `-TODO.md` only if a human must finish it) and
  the Results section is in it.
- `git status --porcelain` is empty. Leftovers in the task folder are the exact failure
  that wedged the queue; anywhere else they block every later task in that repo.
- If the project forbids committing, the tree will not be clean — say so explicitly.

If any check fails, **say so loudly in your final message** ("task file NOT renamed",
"working tree still dirty: …") instead of reporting success. A run that ends dirty is a
run that did not finish.
