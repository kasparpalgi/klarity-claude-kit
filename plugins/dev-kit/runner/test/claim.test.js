import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { claim, withMachine } from "../src/claim.js";

const NAME = "007-cookie-TODO.md";

/** A bare origin with one Auto task, and two runners' clones of it. */
function setup() {
  const root = mkdtempSync(join(tmpdir(), "claim-"));
  const run = (cwd, ...a) => execFileSync("git", a, { cwd, encoding: "utf8" });
  run(root, "init", "-q", "--bare", "origin.git");
  const seed = join(root, "seed");
  run(root, "clone", "-q", "origin.git", "seed");
  mkdirSync(join(seed, "doc/todo"), { recursive: true });
  writeFileSync(join(seed, "doc/todo", NAME), "> Run with: Opus 5 / high\n\n# Cookie\n");
  for (const [k, v] of [["user.email", "t@t.t"], ["user.name", "t"]]) run(seed, "config", k, v);
  run(seed, "add", "-A");
  run(seed, "commit", "-qm", "task");
  run(seed, "push", "-q", "origin", "HEAD");
  const clone = (name) => {
    run(root, "clone", "-q", "origin.git", name);
    const path = join(root, name);
    for (const [k, v] of [["user.email", "t@t.t"], ["user.name", name]]) run(path, "config", k, v);
    const task = { name: NAME, number: "007", path: join(path, "doc/todo", NAME) };
    return { path, task, git: (...a) => run(path, ...a) };
  };
  return { dell: clone("dell"), karel: clone("karel") };
}

test("withMachine puts the line under the tier line", () => {
  assert.equal(
    withMachine("> Run with: Opus 5 / high\n\n# T\n", "dell"),
    "> Run with: Opus 5 / high\n> Machine: dell\n\n# T\n",
  );
  assert.equal(withMachine("\n# T\n", "dell"), "> Machine: dell\n\n# T\n");
});

test("of two runners claiming the same Auto task, exactly one wins", async () => {
  const { dell, karel } = setup();
  assert.equal(await claim(dell.path, "doc/todo", dell.task, "dell"), true);
  assert.equal(await claim(karel.path, "doc/todo", karel.task, "karel"), false);

  // The loser is back where it was: clean, its claim commit gone.
  assert.equal(karel.git("status", "--porcelain"), "");
  assert.equal(karel.git("rev-parse", "HEAD"), karel.git("rev-parse", "origin/HEAD"));
  karel.git("pull", "-q", "--ff-only");
  assert.match(readFileSync(karel.task.path, "utf8"), /^> Machine: dell$/m);
});
