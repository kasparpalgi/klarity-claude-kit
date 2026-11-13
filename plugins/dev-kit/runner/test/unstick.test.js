import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileUnstick } from "../src/unstick.js";

const DIR = "doc/todo";

/** A clone of a bare origin with one stuck task in its folder. */
function setup() {
  const root = mkdtempSync(join(tmpdir(), "unstick-"));
  const run = (cwd, ...a) => execFileSync("git", a, { cwd, encoding: "utf8" });
  run(root, "init", "-q", "--bare", "-b", "main", "origin.git");
  run(root, "clone", "-q", "origin.git", "dell");
  const repo = join(root, "dell");
  run(repo, "config", "user.email", "t@t.t");
  run(repo, "config", "user.name", "t");
  mkdirSync(join(repo, DIR), { recursive: true });
  writeFileSync(
    join(repo, DIR, "231-runnerApi-TODO.md"),
    "> Run with: Opus 5.5 / medium\n> Machine: mac\n\n# Runner API\n",
  );
  run(repo, "add", "-A");
  run(repo, "commit", "-qm", "base");
  run(repo, "push", "-q", "origin", "HEAD:main");
  return { repo, run };
}

const stuck = {
  number: "231",
  stem: "231-runnerApi",
  name: "231-runnerApi-TODO.md",
};

test("a stuck task gets one pushed fixer on this machine, at its own tier", async () => {
  const { repo, run } = setup();
  const args = { repoPath: repo, dir: DIR, task: stuck, machine: "dell" };
  assert.equal(await fileUnstick(args), "filed 232-unstick231-TODO.md");
  const body = readFileSync(join(repo, DIR, "232-unstick231-TODO.md"), "utf8");
  assert.match(body, /^> Run with: Opus 5\.5 \/ medium\n> Machine: dell \(the stuck run's log is here\)\n/);
  assert.ok(body.includes(join(repo, DIR, "231-runnerApi.log")));
  assert.match(
    run(repo, "log", "--oneline", "origin/main", "-1"),
    /unstick231/,
  );
  assert.equal(await fileUnstick(args), null, "one fixer per task");
  assert.equal(readdirSync(join(repo, DIR)).length, 2);
});

test("a stuck fixer files no fixer of its own", async () => {
  const { repo } = setup();
  const task = {
    number: "232",
    stem: "232-unstick231",
    name: "232-unstick231-TODO.md",
  };
  assert.equal(await fileUnstick({ repoPath: repo, dir: DIR, task }), null);
});
