import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  closeWorktree,
  landBookkeeping,
  openWorktree,
  shipBranch,
} from "../src/worktree.js";

const DIR = "doc/todo";
const STEM = "078-mentor";

/**
 * A bare origin, the runner's clone of it (with a gitignored `.env`), and a fake `gh`
 * that logs its argv and answers `pr list` with `prs.json`.
 */
function setup() {
  const root = mkdtempSync(join(tmpdir(), "wt-"));
  const run = (cwd, ...a) =>
    execFileSync("git", a, { cwd, encoding: "utf8" }).trim();
  run(root, "init", "-q", "--bare", "-b", "main", "origin.git");
  run(root, "clone", "-q", "origin.git", "clone");
  const clone = join(root, "clone");
  run(clone, "config", "user.email", "t@t.t");
  run(clone, "config", "user.name", "t");
  mkdirSync(join(clone, DIR), { recursive: true });
  writeFileSync(join(clone, DIR, `${STEM}-TODO.md`), "# Mentor\n");
  writeFileSync(join(clone, ".gitignore"), ".env\n");
  writeFileSync(join(clone, "app.js"), "1\n");
  run(clone, "add", "-A");
  run(clone, "commit", "-qm", "base");
  run(clone, "push", "-q", "origin", "HEAD:main");
  writeFileSync(join(clone, ".env"), "KEY=1\n");

  const bin = join(root, "bin");
  mkdirSync(bin);
  writeFileSync(join(root, "prs.json"), "[]");
  writeFileSync(
    join(bin, "gh"),
    `#!/bin/sh\necho "$*" >> "${root}/gh.log"\ncase "$1 $2" in\n  "pr list") cat "${root}/prs.json" ;;\n  "pr create") echo https://github.com/o/r/pull/95 ;;\nesac\n`,
  );
  chmodSync(join(bin, "gh"), 0o755);
  process.env.PATH = `${bin}:${process.env.PATH}`;
  process.env.KANBAN_RUNNER_WORKTREES = join(root, "worktrees");
  const calls = () =>
    existsSync(join(root, "gh.log"))
      ? readFileSync(join(root, "gh.log"), "utf8").trim().split("\n")
      : [];
  return { root, clone, run, calls };
}

const ship = (path, o = {}) =>
  shipBranch({
    repoName: "o/r",
    path,
    stem: STEM,
    base: "main",
    dir: DIR,
    title: "Mentor",
    issue: "78",
    ...o,
  });

test("a task's worktree is its own branch off origin/main, with the clone's secrets", async () => {
  const { clone, run } = setup();
  const path = await openWorktree(clone, STEM, "main");
  assert.equal(run(path, "branch", "--show-current"), `todo/${STEM}`);
  assert.equal(
    run(path, "rev-parse", "HEAD"),
    run(clone, "rev-parse", "origin/main"),
  );
  assert.equal(readFileSync(join(path, ".env"), "utf8"), "KEY=1\n");
  assert.equal(
    run(clone, "branch", "--show-current"),
    "main",
    "the clone never leaves main",
  );
  assert.equal(
    await openWorktree(clone, STEM, "main"),
    path,
    "an unfinished attempt is reused",
  );
});

test("work left uncommitted goes to the branch and a draft PR — never to main", async () => {
  const { clone, run, calls } = setup();
  const path = await openWorktree(clone, STEM, "main");
  writeFileSync(join(path, "app.js"), "2\n");

  const shipped = await ship(path);

  assert.deepEqual(
    { pr: shipped.pr, opened: shipped.opened, leftover: shipped.leftover },
    { pr: 95, opened: true, leftover: true },
  );
  assert.equal(run(path, "status", "--porcelain"), "");
  assert.match(
    run(path, "log", "-1", "--format=%s"),
    /^wip\(todo\): .* \(#78\)$/,
  );
  assert.equal(
    run(clone, "ls-remote", "origin", `refs/heads/todo/${STEM}`).split("\t")[0],
    run(path, "rev-parse", "HEAD"),
  );
  assert.equal(
    run(clone, "ls-remote", "origin", "refs/heads/main").split("\t")[0],
    run(clone, "rev-parse", "HEAD"),
  );
  const create = calls().find((c) => c.startsWith("pr create"));
  assert.match(
    create,
    /--draft --base main --head todo\/078-mentor --title Mentor \(#78\)/,
  );
  assert.ok(calls().includes("Closes #78"), "the body closes the issue");
  await closeWorktree(clone, path);
  assert.equal(existsSync(path), false);
});

test("leftovers pushed to a ready PR turn it back into a draft", async () => {
  const { root, clone, calls } = setup();
  const path = await openWorktree(clone, STEM, "main");
  writeFileSync(
    join(root, "prs.json"),
    '[{"number":94,"isDraft":false,"url":"u"}]',
  );
  writeFileSync(join(path, "app.js"), "3\n");

  const shipped = await ship(path);

  assert.equal(shipped.pr, 94);
  assert.equal(shipped.opened, false);
  assert.ok(calls().some((c) => c.startsWith("pr ready 94 --undo")));
  assert.ok(!calls().some((c) => c.startsWith("pr create")));
});

test("a session that only wrote its task file lands that on main, with no PR", async () => {
  const { clone, run, calls } = setup();
  const path = await openWorktree(clone, STEM, "main");
  run(path, "mv", `${DIR}/${STEM}-TODO.md`, `${DIR}/${STEM}-DONE.md`);
  writeFileSync(
    join(path, DIR, `${STEM}-DONE.md`),
    "# Mentor\n\n## Results\n\nAlready done.\n",
  );
  run(path, "add", "-A");
  run(path, "commit", "-qm", "docs(todo): 078 already done (#78)");

  const shipped = await ship(path);

  assert.ok(shipped.bookkeeping);
  assert.ok(!calls().some((c) => c.startsWith("pr create")));
  assert.equal(
    await landBookkeeping(clone, shipped.bookkeeping, DIR, "main"),
    true,
  );
  assert.ok(existsSync(join(clone, DIR, `${STEM}-DONE.md`)));
  assert.ok(!existsSync(join(clone, DIR, `${STEM}-TODO.md`)));
  assert.equal(
    run(clone, "log", "-1", "--format=%s"),
    "docs(todo): 078 already done (#78)",
  );
  assert.equal(run(clone, "status", "--porcelain"), "");
});

test("a failed run's task-file edits still go to a draft PR, not main", async () => {
  const { clone, calls } = setup();
  const path = await openWorktree(clone, STEM, "main");
  writeFileSync(
    join(path, DIR, `${STEM}-TODO.md`),
    "# Mentor\n\n## Plan\n\nhalf\n",
  );

  const shipped = await ship(path, { bookkeeping: false });

  assert.equal(shipped.pr, 95);
  assert.ok(calls().some((c) => c.startsWith("pr create")));
});

test("a session that changed nothing ships nothing", async () => {
  const { clone, calls } = setup();
  const path = await openWorktree(clone, STEM, "main");
  assert.equal((await ship(path)).ahead, 0);
  assert.ok(!calls().some((c) => c.startsWith("pr create")));
});

test("a task-folder leftover in a ready PR is bookkeeping: it stays ready", async () => {
  const { root, clone, calls } = setup();
  const path = await openWorktree(clone, STEM, "main");
  writeFileSync(
    join(root, "prs.json"),
    '[{"number":94,"isDraft":false,"url":"u","title":"T","headRefName":"todo/078-mentor"}]',
  );
  writeFileSync(join(path, DIR, `${STEM}-TODO.md`), "# Mentor\n\n## Results\n");

  const shipped = await ship(path);

  assert.equal(shipped.pr, 94);
  assert.equal(shipped.undone, null);
  assert.ok(!calls().some((c) => c.startsWith("pr ready")));
});

test("a session that wandered off its branch never resets it or ships another's commits", async () => {
  const { clone, run } = setup();
  run(clone, "switch", "-qc", "todo/050-other");
  writeFileSync(join(clone, "other.js"), "x\n");
  run(clone, "add", "-A");
  run(clone, "commit", "-qm", "other");
  run(clone, "push", "-q", "origin", "HEAD");
  run(clone, "switch", "-q", "main");

  const path = await openWorktree(clone, STEM, "main");
  writeFileSync(join(path, "app.js"), "2\n");
  run(path, "commit", "-qam", "work");
  const tip = run(path, "rev-parse", "HEAD");
  run(path, "switch", "-q", "--detach", "origin/main");
  await assert.rejects(ship(path), /off todo\/078-mentor/);
  assert.equal(run(path, "rev-parse", `todo/${STEM}`), tip, "branch kept");

  const other = await openWorktree(clone, "079-x", "main");
  run(other, "switch", "-q", "--detach", "origin/todo/050-other");
  writeFileSync(join(other, "app.js"), "3\n");
  run(other, "commit", "-qam", "on top of 050");
  await assert.rejects(
    ship(other, { stem: "079-x" }),
    /another branch's commits/,
  );
});

test("a detached session that started from main still ships to its branch", async () => {
  const { clone, run } = setup();
  const path = await openWorktree(clone, STEM, "main");
  run(path, "switch", "-q", "--detach");
  writeFileSync(join(path, "app.js"), "2\n");
  run(path, "commit", "-qam", "work");

  const shipped = await ship(path);

  assert.equal(shipped.pr, 95);
  assert.equal(run(path, "branch", "--show-current"), `todo/${STEM}`);
});

test("a branch whose bookkeeping did not land keeps its commit for the next attempt", async () => {
  const { clone, run } = setup();
  const path = await openWorktree(clone, STEM, "main");
  writeFileSync(join(path, DIR, `${STEM}-TODO.md`), "# Mentor\n\n## Plan\n");
  run(path, "commit", "-qam", "docs(todo): plan");
  const tip = run(path, "rev-parse", "HEAD");
  await closeWorktree(clone, path);

  const again = await openWorktree(clone, STEM, "main");

  assert.equal(run(again, "rev-parse", "HEAD"), tip);
});
