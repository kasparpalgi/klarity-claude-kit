---
name: debug
description: Find the root cause before changing code. Use when fixing a bug, a failing test, a crash or any behaviour that does not match expectations.
---

# Root cause first

Adapted from [obra/superpowers](https://github.com/obra/superpowers) `systematic-debugging` (MIT).
A fix you cannot explain is a guess. Guesses stack up and hide the real bug.

1. **Reproduce.** Get the exact error, the failing test or the steps. No repro → gather
   evidence (logs, console, network) until you have one. Never fix what you have not seen.
2. **Trace.** Follow the bad value backwards to where it first goes wrong — not where it
   finally crashes. Check `git log -p` on the suspect lines: what changed recently?
3. **One hypothesis.** State it in one sentence ("X is null because Y runs before Z"),
   then prove or kill it with the smallest check: a log line, a test, a query.
4. **Fix the cause, with a test.** Write a test that fails for the reason you found, make
   it pass, remove the debug output.

Rules:

- One change at a time. Three failed fixes in a row → stop, your model of the system is
  wrong; go back to step 2.
- Never weaken a test, add a retry or swallow an error to make a symptom go away.
- Done means the original repro now passes — show the output, do not claim it.
