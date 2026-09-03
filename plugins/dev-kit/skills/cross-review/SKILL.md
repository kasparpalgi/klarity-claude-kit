---
name: cross-review
description: Pipe the current diff to a second-vendor AI CLI for an independent bug review. Use when the user types /cross-review or asks for a second opinion from a different model.
disable-model-invocation: true
---

# Cross-Review

A second-vendor review catches blind spots that Claude shares with itself.

## Prerequisite

Install the `llm` tool once per machine:

```bash
pip install llm
llm install llm-gemini           # or: llm install llm-anthropic (different model family)
llm keys set gemini              # paste your key from ai.google.dev (free tier available)
```

## Run

```bash
BASE=${1:-$(git merge-base HEAD origin/main)}
git diff "$BASE" | llm -m gemini-3.1-flash-lite \
  "You are a senior code reviewer. Review this diff for: correctness bugs, race conditions,
   error handling gaps, security issues. Be specific. Output a numbered list of findings
   only — no preamble, no summary."
```

Pass a commit hash as `$1` to pin the base:

```bash
/cross-review abc1234
```

## Compare

Run `/code-review medium` first, then run this. Findings that appear in both are
well-established; findings only in one deserve scrutiny. If the cross-vendor list is
entirely a subset of Claude's output, the marginal value was low — record that.

## Decision log

Update `doc/todo/011-parallelReviewLoop-DONE.md` with the verdict:
adopt (caught ≥1 novel bug) / drop (no novel findings in N runs).
