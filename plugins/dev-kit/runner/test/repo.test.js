import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { autoFinish, dirtyPaths, parkDirty } from "../src/repo.js";

/** A throwaway git repo with one committed file, so later edits read as dirty. */
function repo() {
  const path = mkdtempSync(join(tmpdir(), "repo-"));
  const git = (...a) => execFileSync("git", a, { cwd: path });
  git("init", "-q");
  git("config", "user.email", "t@t.t");
  git("config", "user.name", "t");
  writeFileSync(join(path, "a.txt"), "one\n");
  git("add", "-A");
  git("commit", "-qm", "init");
  return { path, git };
}

test("parkDirty stashes a run's leftover so the tree goes clean", async () => {
  const { path } = repo();
  writeFileSync(join(path, "a.txt"), "two\n"); // a modified tracked file
  writeFileSync(join(path, "new.ts"), "x"); // and an untracked one
  assert.equal((await dirtyPaths(path)).length, 2);

  const label = await parkDirty(path, "167-x-TODO.md");
  assert.match(label, /^runner: parked 167-x-TODO\.md at /);
  assert.deepEqual(await dirtyPaths(path), []); // preflight would now pass
});

test("parkDirty is a no-op on a clean tree", async () => {
  const { path } = repo();
  assert.equal(await parkDirty(path, "167-x-TODO.md"), null);
});

test("parked work is recoverable with git stash pop", async () => {
  const { path, git } = repo();
  writeFileSync(join(path, "a.txt"), "two\n");
  await parkDirty(path, "167-x-TODO.md");
  git("stash", "pop");
  assert.deepEqual(await dirtyPaths(path), ["a.txt"]);
});

/** A repo with a committed task file under `doc/todo/`, the way a run leaves it. */
function repoWithTask(name, body) {
  const { path, git } = repo();
  mkdirSync(join(path, "doc/todo"), { recursive: true });
  writeFileSync(join(path, "doc/todo", name), body);
  git("add", "-A");
  git("commit", "-qm", "task");
  return { path, git };
}

test("autoFinish renames -TODO to -DONE, records a note, and leaves a clean tree", async () => {
  const { path } = repoWithTask("171-x-TODO.md", "# X\n\nOriginal.\n");
  const done = await autoFinish(path, "doc/todo", "171-x-TODO.md", false);

  assert.equal(done, "171-x-DONE.md");
  assert.ok(!existsSync(join(path, "doc/todo/171-x-TODO.md")));
  assert.ok(existsSync(join(path, "doc/todo/171-x-DONE.md")));
  assert.deepEqual(await dirtyPaths(path), []); // the rename is committed
  assert.match(
    readFileSync(join(path, "doc/todo/171-x-DONE.md"), "utf8"),
    /## Results/,
  );
});

test("autoFinish keeps the agent's own Results instead of appending its own", async () => {
  const body = "# X\n\n## Results\n\nAgent wrote this.\n";
  const { path } = repoWithTask("172-x-TODO.md", body);
  await autoFinish(path, "doc/todo", "172-x-TODO.md", true);

  const text = readFileSync(join(path, "doc/todo/172-x-DONE.md"), "utf8");
  assert.match(text, /Agent wrote this\./);
  assert.equal(text.match(/## Results/g).length, 1); // not doubled
});
