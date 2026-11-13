import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { handOver } from "../src/handover.js";
import { machineFilter, reasoned, withoutMachine } from "../src/machine.js";
import { listPending } from "../src/queue.js";

const DIR = "doc/todo";
const card = (n) => `00000000-0000-0000-0000-000000000${n}`;
const task = (n, slug, head) => [
  `${DIR}/${n}-${slug}-TODO.md`,
  `${head}\n# ${slug}\n\n_From Kanban card \`${card(n)}\`._\n`,
];

/** An origin, the walled Mac's clone of it, and an in-memory board of `agent_machine`s. */
function setup() {
  const root = mkdtempSync(join(tmpdir(), "handover-"));
  process.env.KANBAN_RUNNER_WORKTREES = join(root, "worktrees");
  process.env.CLAUDE_CONFIG_FILE = join(root, ".claude.json");
  const git = (cwd, ...a) =>
    execFileSync("git", a, { cwd, encoding: "utf8" }).trim();
  git(root, "init", "-q", "--bare", "-b", "main", "origin.git");
  git(root, "clone", "-q", "origin.git", "clone");
  const clone = join(root, "clone");
  git(clone, "config", "user.email", "t@t.t");
  git(clone, "config", "user.name", "t");
  mkdirSync(join(clone, DIR), { recursive: true });
  for (const [path, text] of [
    task(101, "bare", "> Run with: Opus 5 / high\n> Machine: mac\n"),
    task(102, "reason", "> Machine: mac (the only one that can ssh renlog)\n"),
    task(103, "dell", "> Machine: dell\n"),
    task(104, "autoStarted", "> Run with: Opus 5 / high\n"),
    task(105, "unpushed", "> Machine: mac\n"),
    task(106, "autoNotStarted", ""),
  ])
    writeFileSync(join(clone, path), text);
  git(clone, "add", "-A");
  git(clone, "commit", "-qm", "tasks");
  git(clone, "push", "-q", "origin", "HEAD:main");
  const tree = (stem) => {
    const path = join(root, "worktrees", "clone", stem);
    git(clone, "worktree", "add", "-q", "-b", `run/${stem}`, path, "HEAD");
    return path;
  };
  writeFileSync(join(tree("104-autoStarted"), "half.txt"), "wip\n");
  const kept = tree("105-unpushed");
  writeFileSync(join(kept, "work.js"), "1\n");
  git(kept, "add", "-A");
  git(
    kept,
    "-c",
    "user.email=t@t.t",
    "-c",
    "user.name=t",
    "commit",
    "-qm",
    "work",
  );

  const machines = {
    101: "mac",
    102: "mac",
    103: "dell",
    104: "mac",
    105: "mac",
    106: "mac",
  };
  const board = new Map(Object.entries(machines).map(([n, m]) => [card(n), m]));
  globalThis.fetch = async (_url, { body }) => {
    const { query, variables: v } = JSON.parse(body);
    assert.match(query, /^mutation R/);
    const held = board.get(v.id)?.toLowerCase() === v.m.toLowerCase();
    if (held) board.set(v.id, null);
    return {
      json: async () => ({
        data: { update_todos: { affected_rows: held ? 1 : 0 } },
      }),
    };
  };
  return { root, clone, board, git };
}

test("a walled runner gives its bare and started tasks to any runner, and keeps the rest", async () => {
  const { root, clone, board, git } = setup();
  const line = await handOver({
    kanban: { endpoint: "x", adminSecret: "s" },
    repoPath: clone,
    dir: DIR,
    pending: listPending(clone, DIR),
    isMine: machineFilter({ machine: "mac" }),
    me: "mac",
    until: "13/11/2026, 23:31 EET",
    live: async () => false,
  });

  assert.equal(
    line,
    "handed 101, 104 to any free runner — mac is at its usage limit until 13/11/2026, 23:31 EET",
  );
  const onOrigin = (name) =>
    git(join(root, "origin.git"), "show", `main:${DIR}/${name}`);
  assert.doesNotMatch(
    onOrigin("101-bare-TODO.md"),
    /Machine/,
    "Auto on origin now",
  );
  assert.match(
    onOrigin("101-bare-TODO.md"),
    /^> Run with: Opus 5 \/ high\n\n# bare/,
  );
  assert.match(onOrigin("102-reason-TODO.md"), /> Machine: mac \(/);
  assert.match(onOrigin("105-unpushed-TODO.md"), /> Machine: mac/);
  assert.match(
    git(clone, "log", "-1", "--format=%s"),
    /^chore\(todo\): hand 101, 104 to any runner — mac is at/,
  );
  assert.deepEqual(
    [101, 102, 103, 104, 105, 106].map((n) => board.get(card(n))),
    [null, "mac", "dell", null, "mac", "mac"],
  );
  assert.equal(
    existsSync(join(root, "worktrees/clone/104-autoStarted")),
    false,
  );
  assert.match(
    git(clone, "stash", "list"),
    /104-autoStarted \(handed over\)/,
    "its dirt parked",
  );
  assert.equal(
    existsSync(join(root, "worktrees/clone/105-unpushed/work.js")),
    true,
    "resumes here",
  );
  assert.equal(git(clone, "status", "--porcelain"), "");
});

test("a task whose pane still works is not handed over", async () => {
  const { clone, board } = setup();
  const line = await handOver({
    kanban: { endpoint: "x", adminSecret: "s" },
    repoPath: clone,
    dir: DIR,
    pending: listPending(clone, DIR),
    isMine: machineFilter({ machine: "mac" }),
    me: "mac",
    until: "23:31",
    live: async (pane) => pane === "task-101",
  });
  assert.equal(
    line,
    "handed 104 to any free runner — mac is at its usage limit until 23:31",
  );
  assert.equal(board.get(card(101)), "mac");
});

test("withoutMachine drops only the Machine line; reasoned spots a bracketed note", () => {
  assert.equal(
    withoutMachine("> Run with: Opus 5 / high\n> Machine: mac\n\n# T\n"),
    "> Run with: Opus 5 / high\n\n# T\n",
  );
  assert.equal(withoutMachine("# T\n"), "# T\n");
  assert.equal(reasoned("> Machine: mac (+ Pi deploy)\n"), true);
  assert.equal(reasoned("> Machine: mac\n"), false);
  assert.equal(reasoned("# T\n"), false);
});
