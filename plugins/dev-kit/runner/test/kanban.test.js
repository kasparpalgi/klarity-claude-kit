import { test } from "node:test";
import assert from "node:assert/strict";
import { cardIdOf, resultsOf, titleOf } from "../src/kanban.js";

const DONE = `> Run with: Opus 5 / high

# Drag'n'drop crap

## Original Requirement

[NEVER REMOVE]

Make it work like Trello.

_From Kanban card \`951ba857-ccf1-4cfa-9e97-cb85420071a0\`, moved to the agent list._

## Results

**Summary** — card-wide pointer drag.
**Files changed** — TodoItem.svelte
`;

test("finds the card the task file came from", () => {
  assert.equal(cardIdOf(DONE), "951ba857-ccf1-4cfa-9e97-cb85420071a0");
  assert.equal(cardIdOf("# A file nobody filed from Kanban"), null);
});

test("takes the Results section, not the requirement above it", () => {
  const r = resultsOf(DONE);
  assert.match(r, /^## Results/);
  assert.match(r, /card-wide pointer drag/);
  assert.doesNotMatch(r, /Make it work like Trello/);
  assert.equal(resultsOf("# No results here"), null);
});

test("titles a follow-up from its heading", () => {
  assert.equal(titleOf("# Polish the drag ghost\n\ntext", "164-x.md"), "Polish the drag ghost");
  assert.equal(titleOf("no heading", ".claude/todo/164-dragNDropPolish.md"), "164-dragNDropPolish");
});

test("a follow-up quoting its parent card is not mistaken for that card", () => {
  const followUp = `# Drag'n'drop polish (followup to 163)

_Original card requirement (from Kanban card \`951ba857-ccf1-4cfa-9e97-cb85420071a0\`):_

Make it like Trello.
`;
  assert.equal(cardIdOf(followUp), null);
  assert.equal(
    cardIdOf("_From Kanban card `951ba857-ccf1-4cfa-9e97-cb85420071a0`, moved to the agent list._"),
    "951ba857-ccf1-4cfa-9e97-cb85420071a0",
  );
});

test("falls back to the agent's own headings when it wrote no Results", () => {
  const improvised = `# Drag'n'drop crap

## Original Requirement

[NEVER REMOVE]

Make it like Trello.

_From Kanban card \`951ba857-ccf1-4cfa-9e97-cb85420071a0\`, moved to the agent list._

## Investigation

Found the handle-only drag.

## Status

Done, follow-up filed as 164.
`;
  const r = resultsOf(improvised);
  assert.match(r, /^## Investigation/);
  assert.match(r, /follow-up filed as 164/);
  assert.doesNotMatch(r, /Make it like Trello/);
});

test("a file with only a requirement has nothing to report", () => {
  assert.equal(resultsOf("# T\n\n## Original Requirement\n\nDo the thing.\n"), null);
});
