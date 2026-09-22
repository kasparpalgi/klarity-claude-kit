import { test } from "node:test";
import assert from "node:assert/strict";
import { machineFilter, machineOf, mine, slug } from "../src/machine.js";

test("machineOf reads the line the Kanban writes", () => {
  assert.equal(machineOf("> Machine: karel\n\n# Task"), "karel");
  assert.equal(machineOf("> Run with: Opus 5 / high\n> Machine: Kaspar Mac\n"), "kaspar-mac");
  assert.equal(machineOf("Machine: karel"), "karel");
});

test("machineOf is null when the file names none", () => {
  assert.equal(machineOf("> Run with: Opus 5 / high\n\n# Task"), null);
  assert.equal(machineOf(""), null);
  assert.equal(machineOf(undefined), null);
});

test("prose about machines is not a Machine line", () => {
  assert.equal(machineOf("the state machine: rewrite it"), null);
});

test("slug folds label spellings onto one id", () => {
  assert.equal(slug("Karel Ubuntu"), "karel-ubuntu");
  assert.equal(slug("karel-ubuntu"), "karel-ubuntu");
});

test("no machine configured takes everything — the single-machine setup", () => {
  const isMine = machineFilter({});
  assert.equal(isMine(null), true);
  assert.equal(isMine("karel"), true);
});

test("a configured machine takes only its own addressed tasks", () => {
  const isMine = machineFilter({ machine: "karel" });
  assert.equal(isMine("karel"), true);
  assert.equal(isMine("Karel"), false, "machineOf already slugged it");
  assert.equal(isMine("mac"), false);
  assert.equal(isMine(null), false);
});

test("the default machine also takes unaddressed tasks", () => {
  const isMine = machineFilter({ machine: "mac", machineDefault: true });
  assert.equal(isMine(null), true);
  assert.equal(isMine("mac"), true);
  assert.equal(isMine("karel"), false);
});

test("mine() keeps queue order and drops other machines' tasks", () => {
  const pending = [
    { name: "001-a-TODO.md", machine: null },
    { name: "002-b-TODO.md", machine: "karel" },
    { name: "003-c-TODO.md", machine: "mac" },
  ];
  const names = (cfg) => mine(pending, machineFilter(cfg)).map((p) => p.name);
  assert.deepEqual(names({ machine: "karel" }), ["002-b-TODO.md"]);
  assert.deepEqual(names({ machine: "mac", machineDefault: true }), [
    "001-a-TODO.md",
    "003-c-TODO.md",
  ]);
});

test("a machine may answer to more than one spelling", () => {
  const isMine = machineFilter({ machine: ["karel", "Karel Ubuntu"] });
  assert.equal(isMine("karel"), true);
  assert.equal(isMine("karel-ubuntu"), true);
  assert.equal(isMine("mac"), false);
});
