import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { machineFilter } from "../src/machine.js";
import { waitingOnOrigin } from "../src/waiting.js";

/** Our clone with a stale task folder, and origin moved on by the Kanban. */
function setup() {
  const origin = mkdtempSync(join(tmpdir(), "origin-"));
  execFileSync("git", ["init", "-q", "--bare", "-b", "main", origin]);
  const kanban = mkdtempSync(join(tmpdir(), "kanban-"));
  const k = (...a) => execFileSync("git", a, { cwd: kanban });
  k("init", "-q", "-b", "main");
  k("config", "user.email", "t@t.t");
  k("config", "user.name", "t");
  k("remote", "add", "origin", origin);
  mkdirSync(join(kanban, "doc/todo"), { recursive: true });
  const task = (name, body) =>
    writeFileSync(join(kanban, "doc/todo", name), body);
  task("001-old-TODO.md", "> Machine: mac\n");
  k("add", "-A");
  k("commit", "-qm", "old");
  k("push", "-q", "-u", "origin", "main");

  const path = mkdtempSync(join(tmpdir(), "clone-"));
  execFileSync("git", ["clone", "-q", origin, path]);
  writeFileSync(join(path, "schema.json"), "regenerated\n"); // the block

  task("002-new-TODO.md", "> Machine: mac\n");
  task("003-forKarel-TODO.md", "> Machine: karel\n");
  task("004-auto-TODO.md", "no machine line\n");
  task("005-done-TODO.md", "> Machine: mac\n");
  task("005-done-DONE.md", "> Machine: mac\n");
  k("add", "-A");
  k("commit", "-qm", "from Kanban");
  k("push", "-q");
  return path;
}

test("a blocked clone still names the new tasks origin queued for it", async () => {
  const path = setup();
  const mac = machineFilter({ machine: ["mac", "kaspar-mac"] });
  assert.deepEqual(
    (await waitingOnOrigin(path, "doc/todo", mac)).map((t) => t.name),
    ["002-new-TODO.md", "004-auto-TODO.md"],
  );
});

test("an unreadable origin yields nothing rather than throwing", async () => {
  const path = mkdtempSync(join(tmpdir(), "no-git-"));
  assert.deepEqual(await waitingOnOrigin(path, "doc/todo", () => true), []);
});
