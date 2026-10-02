import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import assert from "node:assert";
import { selfUpdate } from "../src/selfUpdate.js";

const git = (cwd, ...args) =>
  execFileSync("git", args, { cwd, encoding: "utf8" }).trim();

/** An upstream with one commit, and a clone of it — the runner's own situation. */
function pair() {
  const root = mkdtempSync(join(tmpdir(), "selfupdate-"));
  const origin = join(root, "origin");
  const clone = join(root, "clone");
  git(root, "init", "-q", "--bare", "-b", "main", origin);
  git(root, "clone", "-q", origin, clone);
  git(clone, "config", "user.email", "t@t");
  git(clone, "config", "user.name", "t");
  writeFileSync(join(clone, "model.js"), "opus 5\n");
  git(clone, "add", "-A");
  git(clone, "commit", "-q", "-m", "first");
  git(clone, "push", "-q", "origin", "main");
  return { origin, clone, root };
}

/** Land a commit upstream, the way the other machine would. */
function pushFromElsewhere(origin, root, subject) {
  const other = join(root, "other");
  git(root, "clone", "-q", origin, other);
  git(other, "config", "user.email", "t@t");
  git(other, "config", "user.name", "t");
  writeFileSync(join(other, "model.js"), "opus 5.5\n");
  git(other, "commit", "-qam", subject);
  git(other, "push", "-q", "origin", "main");
}

test("pulls a fix the other machine pushed and names it", async () => {
  const { origin, clone, root } = pair();
  pushFromElsewhere(origin, root, "resolve Opus 5.5 to its own model id");
  const moved = await selfUpdate(clone);
  assert.match(moved, /resolve Opus 5\.5/);
  assert.equal(
    git(clone, "show", "-s", "--format=%s"),
    "resolve Opus 5.5 to its own model id",
  );
});

test("returns null when the checkout is already current", async () => {
  const { clone } = pair();
  assert.equal(await selfUpdate(clone), null);
});

test("leaves a dirty tree alone — someone is working in it", async () => {
  const { origin, clone, root } = pair();
  pushFromElsewhere(origin, root, "a fix");
  writeFileSync(join(clone, "model.js"), "half-written experiment\n");
  assert.equal(await selfUpdate(clone), null);
  assert.equal(git(clone, "show", "-s", "--format=%s"), "first");
});

test("restarts on a commit made in the runner's own checkout, not only on a pull", async () => {
  const { clone } = pair();
  assert.equal(await selfUpdate(clone), null);
  writeFileSync(join(clone, "model.js"), "opus 5.5\n");
  git(clone, "commit", "-qam", "fix made on this machine");
  assert.match(await selfUpdate(clone), /fix made on this machine/);
});
