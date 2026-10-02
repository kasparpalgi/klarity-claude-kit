import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  cardIdOf,
  doneFile,
  finishedCards,
  resultsOf,
  stuckCards,
  titleOf,
} from "../src/kanban.js";

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
  assert.equal(
    titleOf("# Polish the drag ghost\n\ntext", "164-x.md"),
    "Polish the drag ghost",
  );
  assert.equal(
    titleOf("no heading", ".claude/todo/164-dragNDropPolish.md"),
    "164-dragNDropPolish",
  );
});

test("a follow-up quoting its parent card is not mistaken for that card", () => {
  const followUp = `# Drag'n'drop polish (followup to 163)

_Original card requirement (from Kanban card \`951ba857-ccf1-4cfa-9e97-cb85420071a0\`):_

Make it like Trello.
`;
  assert.equal(cardIdOf(followUp), null);
  assert.equal(
    cardIdOf(
      "_From Kanban card `951ba857-ccf1-4cfa-9e97-cb85420071a0`, moved to the agent list._",
    ),
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
  assert.equal(
    resultsOf("# T\n\n## Original Requirement\n\nDo the thing.\n"),
    null,
  );
});

test("reads the -DONE file of this task, not of a namesake", () => {
  const dir = mkdtempSync(join(tmpdir(), "kanban-"));
  for (const n of ["019-errors-DONE.md", "019-task012Fix-BLOCKED.md"])
    writeFileSync(join(dir, n), "x");
  assert.equal(doneFile(dir, "019-errors"), "019-errors-DONE.md");
  assert.equal(doneFile(dir, "019-task012Fix"), "019-task012Fix-BLOCKED.md");
  assert.equal(doneFile(dir, "019-neverRan"), undefined);
});

test("a finished task whose card still points at its -TODO is stuck; a redo or a parked card is not", () => {
  const dir = mkdtempSync(join(tmpdir(), "todo-"));
  const card = (id) => `# T\n\n_From Kanban card \`${id}\`._\n`;
  const [a, b, c, d] = ["a", "b", "c", "d"].map(
    (x) => x.repeat(8) + "-1111-2222-3333-444455556666",
  );
  writeFileSync(join(dir, "034-manageGigs-DONE.md"), card(a));
  writeFileSync(join(dir, "012-apple-DONE.md"), card(b));
  writeFileSync(join(dir, "019-errors-DONE.md"), card(c));
  writeFileSync(join(dir, "035-sessions-TODO.md"), card(d));
  writeFileSync(join(dir, "036-handWritten-DONE.md"), "# no card");

  const byCard = finishedCards(dir);
  assert.equal(byCard.size, 3);
  const todo = { name: "Todo" };
  const todos = [
    { id: a, list: todo, task_file_path: "doc/todo/034-manageGigs-TODO.md" },
    { id: b, list: { name: "Ready" }, task_file_path: "doc/todo/012-apple-TODO.md" },
    { id: c, list: todo, task_file_path: "doc/todo/019-errors-DONE.md" },
    { id: d, list: todo, task_file_path: "doc/todo/035-sessions-TODO.md" },
  ];
  assert.deepEqual(stuckCards(todos, byCard, { todo: "TODO", doing: "Doing" }), [
    "034-manageGigs-DONE.md",
  ]);
});
