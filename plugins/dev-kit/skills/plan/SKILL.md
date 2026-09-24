---
name: plan
description: Turn a request into a new numbered task file in doc/todo/ without implementing it. Use when the user types /plan or asks to plan a feature before building.
argument-hint: '[request]'
disable-model-invocation: true
---

# Plan: $ARGUMENTS

Research first, then write **one file** — do not implement.

1. Read the codebase parts the request touches. Find the task folder: use `.claude/todo/`
   if it exists, otherwise `doc/todo/`. Check it for related past tasks.
2. **Create a GitHub issue** for the task — run:
   ```
   gh issue create --title "<Task name>" --body "<one-sentence summary of $ARGUMENTS>"
   ```
   Capture the issue number from the output URL (e.g. `…/issues/42` → `42`).
   Use that number as the task file number so `(#42)` in a commit subject closes the issue.
   If `gh` is unavailable or the repo has no remote, fall back to the next free number.
3. **Handle conflicts.** If a file starting with `<NNN>-` already exists in the task folder:
   - Name ends with `-DONE.md` → move it to `<task-folder>/archive/`
   - Any other suffix → move it to `<task-folder>/duplicate/`
   Create the subdirectory if needed (`mkdir -p`).
4. Write `<task-folder>/<NNN>-<camelCaseName>-TODO.md`:

```markdown
> Run with: <Opus 4.6|4.8|5 | Sonnet 4.6|5 | Haiku 4.5> / <low | medium | high | xhigh | max>

# <Task name>

## Original Requirement

$ARGUMENTS

## Analysis

- Affected files:
- Unknowns / decisions needed:

## Implementation Plan

1.

## Verification

- [ ] `npm run check`
- [ ] tests
- [ ] browser-tested
```

5. If the request is genuinely more than one session, split it instead of writing one giant
   file. Write the **first** slice as `<NNN>-<name>-TODO.md` — that is the one the runner
   picks up next. Write every **later** slice as `<NNN>-<name>.md` with **no suffix**: the
   runner files those as Kanban **Backlog** cards for a human to release, so the queue does
   not run the whole feature back-to-back unreviewed. Each file must still be independently
   runnable via `/todo <n>` once it reaches the queue.
6. Report the file path(s) and the GitHub issue URL. Stop. Do not start building.
