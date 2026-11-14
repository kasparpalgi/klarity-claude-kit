import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { catchUp, landWorktree } from "../src/land.js";
import { preflight } from "../src/repo.js";
import { sweepWorktrees } from "../src/sweep.js";
import { openWorktree } from "../src/worktree.js";

const DIR = "doc/todo";
const STEM = "091-always";

/** A bare origin, the runner's clone of it, and a second clone standing in for the Kanban. */
function setup() {
  // realpath: macOS tmpdir is /var → /private/var, and `git worktree list` prints the latter.
  const root = realpathSync(mkdtempSync(join(tmpdir(), "land-")));
  const run = (cwd, ...a) =>
    execFileSync("git", a, { cwd, encoding: "utf8" }).trim();
  run(root, "init", "-q", "--bare", "-b", "main", "origin.git");
  const clone = (name) => {
    run(root, "clone", "-q", "origin.git", name);
    const dir = join(root, name);
    run(dir, "config", "user.email", "t@t.t");
    run(dir, "config", "user.name", "t");
    return dir;
  };
  const repo = clone("repo");
  mkdirSync(join(repo, DIR), { recursive: true });
  writeFileSync(join(repo, DIR, `${STEM}-TODO.md`), "# Always\n");
  writeFileSync(join(repo, "app.js"), "1\n");
  run(repo, "add", "-A");
  run(repo, "commit", "-qm", "base");
  run(repo, "push", "-q", "origin", "HEAD:main");
  const kanban = clone("kanban");
  process.env.KANBAN_RUNNER_WORKTREES = join(root, "worktrees");
  process.env.CLAUDE_CONFIG_FILE = join(root, ".claude.json");
  const tree = () =>
    openWorktree(repo, STEM, "main", () => {}, { direct: true });
  const commit = (cwd, file, text, msg = "work") => {
    writeFileSync(join(cwd, file), text);
    run(cwd, "add", "-A");
    run(cwd, "commit", "-qm", msg);
  };
  const tip = (ref = "main") =>
    run(repo, "ls-remote", "origin", `refs/heads/${ref}`).split("\t")[0];
  return { root, repo, kanban, run, tree, commit, tip };
}

const finish = (run, path) => {
  renameSync(
    join(path, DIR, `${STEM}-TODO.md`),
    join(path, DIR, `${STEM}-DONE.md`),
  );
  run(path, "add", "-A");
  run(path, "commit", "-qm", "docs(todo): done");
};

test("a push-to-main run gets its own run/ branch, tracking origin/main", async () => {
  const { repo, run, tree, commit } = setup();
  commit(repo, ".gitignore", ".claude/settings.local.json\n");
  mkdirSync(join(repo, ".claude"));
  writeFileSync(join(repo, ".claude", "settings.local.json"), "{}\n");
  const path = await tree();
  assert.ok(
    existsSync(join(path, ".claude", "settings.local.json")),
    "the clone's ignored Claude settings come along",
  );
  assert.equal(run(path, "branch", "--show-current"), `run/${STEM}`);
  assert.equal(run(path, "rev-parse", "--abbrev-ref", "@{u}"), "origin/main");
  assert.equal(run(path, "rev-parse", "HEAD"), run(repo, "rev-parse", "HEAD"));
  run(path, "pull", "-q"); // the skill's `git pull` works as on main
  assert.equal(run(repo, "branch", "--show-current"), "main");
});

test("a run that leaves its tree dirty does not block the next task", async () => {
  const { repo, tree } = setup();
  const path = await tree();
  writeFileSync(join(path, "app.js"), "half-done\n");
  const r = await preflight(repo, DIR);
  assert.equal(r.reason, undefined, "the clone is clean: nothing blocks");
});

test("what the run committed lands on main, then the tree and its branch go", async () => {
  const { repo, run, tree, commit, tip } = setup();
  const path = await tree();
  commit(path, "app.js", "2\n");
  finish(run, path);

  assert.deepEqual(await landWorktree(repo, path, STEM, "main"), { landed: 2 });
  assert.equal(tip(), run(repo, "rev-parse", `origin/main`));
  assert.equal(existsSync(path), false);
  assert.equal(run(repo, "branch", "--list", "run/*"), "", "branch deleted");
  assert.equal(await catchUp(repo, "main"), true);
  assert.ok(existsSync(join(repo, DIR, `${STEM}-DONE.md`)));
  assert.equal(run(repo, "rev-parse", "HEAD"), tip());
});

test("origin moving on meanwhile is rebased over, the runner's own commit included", async () => {
  const { repo, kanban, run, tree, commit, tip } = setup();
  commit(repo, "ignore.txt", "*.log\n", "chore: ignore runner task logs");
  const path = await tree();
  commit(path, "app.js", "2\n");
  run(kanban, "pull", "-q");
  commit(kanban, `${DIR}/092-next-TODO.md`, "# Next\n", "docs(todo): 092");
  run(kanban, "push", "-q", "origin", "HEAD:main");

  const r = await landWorktree(repo, path, STEM, "main");

  assert.equal(r.landed, 2);
  assert.equal(run(repo, "log", "-1", "--format=%s", tip()), "work");
  assert.equal(await catchUp(repo, "main"), true);
  assert.equal(run(repo, "rev-parse", "HEAD"), tip());
  assert.ok(existsSync(join(repo, DIR, "092-next-TODO.md")));
  assert.equal(run(repo, "status", "--porcelain"), "");
});

test("a session that pushed HEAD:main itself has nothing left to land", async () => {
  const { repo, run, tree, commit } = setup();
  const path = await tree();
  commit(path, "app.js", "2\n");
  run(path, "push", "-q", "origin", "HEAD:main");
  assert.deepEqual(await landWorktree(repo, path, STEM, "main"), { landed: 0 });
  assert.equal(existsSync(path), false);
});

test("work that will not rebase stays in its worktree", async () => {
  const { repo, kanban, run, tree, commit, tip } = setup();
  const path = await tree();
  commit(path, "app.js", "mine\n");
  run(kanban, "pull", "-q");
  commit(kanban, "app.js", "theirs\n");
  run(kanban, "push", "-q", "origin", "HEAD:main");
  const before = tip();

  const r = await landWorktree(repo, path, STEM, "main");

  assert.match(r.error, /does not rebase/);
  assert.equal(tip(), before);
  assert.ok(existsSync(path));
  assert.equal(run(path, "status", "--porcelain"), "", "rebase aborted");
});

test("a session that made a branch of its own pushes it there, not to main", async () => {
  const { repo, run, tree, commit, tip } = setup();
  const before = tip();
  const path = await tree();
  run(path, "switch", "-qc", "feature/x");
  commit(path, "app.js", "2\n");

  assert.deepEqual(await landWorktree(repo, path, STEM, "main"), {
    branch: "feature/x",
  });
  assert.equal(tip(), before, "main untouched");
  assert.equal(tip("feature/x"), run(repo, "rev-parse", "origin/feature/x"));
  assert.equal(existsSync(path), false);
});

test("the clone does not catch up while a person has it on another branch", async () => {
  const { repo, run } = setup();
  run(repo, "switch", "-qc", "mine");
  assert.equal(await catchUp(repo, "main"), false);
});

const sweep = async (repo, o = {}) =>
  (
    await sweepWorktrees({
      repoPath: repo,
      dir: DIR,
      base: "main",
      viaPr: false,
      live: async () => false,
      ...o,
    })
  ).lines;

test("the sweep lands a finished tree left behind, stashing its leftovers", async () => {
  const { repo, run, tree, commit, tip } = setup();
  const path = await tree();
  commit(path, "app.js", "2\n");
  finish(run, path);
  writeFileSync(join(path, "stray.txt"), "x\n");

  const lines = await sweep(repo);

  assert.match(
    lines.join("\n"),
    /removed the worktree of 091-always, landed 2 commit\(s\) on main, leftovers stashed/,
  );
  assert.equal(existsSync(path), false);
  assert.equal(
    run(repo, "log", "-1", "--format=%s", tip()),
    "docs(todo): done",
  );
  assert.match(run(repo, "stash", "list"), /091-always \(sweep\)/);
});

test("the sweep leaves a tree whose task still waits, or whose pane still works", async () => {
  const { repo, run, tree } = setup();
  const path = await tree();
  assert.deepEqual(await sweep(repo), [], "queued: kept for the retry");
  finish(run, path);
  assert.deepEqual(
    await sweep(repo, { live: async (p) => p === "task-091" }),
    [],
  );
  assert.ok(existsSync(path));
});

test("in a pull request repo the sweep only removes a tree that loses nothing", async () => {
  const { repo, run } = setup();
  const path = await openWorktree(repo, STEM, "main");
  run(repo, "rm", "-q", `${DIR}/${STEM}-TODO.md`);
  run(repo, "commit", "-qm", "card gone");
  writeFileSync(join(path, "app.js"), "dirty\n");
  assert.deepEqual(await sweep(repo, { viaPr: true }), []);
  run(path, "checkout", "-q", "app.js");
  assert.match(
    (await sweep(repo, { viaPr: true })).join(),
    /removed the worktree/,
  );
  assert.equal(existsSync(path), false);
});

test("local run/ and todo/ branches already on origin are dropped once", async () => {
  const { repo, run } = setup();
  run(repo, "branch", "run/080-old");
  run(repo, "branch", "todo/081-old");
  run(repo, "switch", "-qc", "todo/082-unpushed");
  writeFileSync(join(repo, "x.js"), "x\n");
  run(repo, "add", "-A");
  run(repo, "commit", "-qm", "local only");
  run(repo, "switch", "-q", "main");

  assert.match((await sweep(repo)).join(), /deleted 2 local/);
  assert.equal(
    run(repo, "branch", "--list", "run/*", "todo/*"),
    "todo/082-unpushed",
  );
});
