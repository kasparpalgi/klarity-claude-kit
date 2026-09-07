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
2. Number the file. If the request has a GitHub issue, **use the issue number** — the
   file number and the issue number are deliberately the same, so `(#165)` in a commit
   subject lands the work on the issue. Otherwise take the next free number.
3. Write `<task-folder>/<NNN>-<camelCaseName>-TODO.md`:

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

4. If the request is genuinely more than one session, split it instead of writing one giant
   file. Write the **first** slice as `<NNN>-<name>-TODO.md` — that is the one the runner
   picks up next. Write every **later** slice as `<NNN>-<name>.md` with **no suffix**: the
   runner files those as Kanban **Backlog** cards for a human to release, so the queue does
   not run the whole feature back-to-back unreviewed. Each file must still be independently
   runnable via `/todo <n>` once it reaches the queue.
5. Report the file path(s) and stop. Do not start building.
