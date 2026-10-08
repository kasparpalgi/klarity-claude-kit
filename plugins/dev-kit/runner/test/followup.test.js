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
import { fileFollowUps, issueName, withIssue } from "../src/followup.js";

test("issueName takes the issue number when it is free", () => {
  assert.equal(
    issueName("054-x.md", 57, ["053-a-DONE.md", "054-x.md"]),
    "057-x.md",
  );
  assert.equal(issueName("054-x.md", 54, ["054-x.md"]), "054-x.md");
});

test("issueName keeps the name when another file holds the number", () => {
  assert.equal(
    issueName("054-x.md", 53, ["053-a-DONE.md", "054-x.md"]),
    "054-x.md",
  );
});

test("withIssue adds the Kanban's issue line once", () => {
  const once = withIssue("# T\n\nbody\n", 7);
  assert.equal(
    once,
    "# T\n\nbody\n\n_GitHub issue #7 — end the commit subject with `(#7)`._\n",
  );
  assert.equal(withIssue(once, 8), once);
});

/** A bare origin, two runner clones, a fake `gh` that counts the issues it opens. */
function setup() {
  const root = mkdtempSync(join(tmpdir(), "followup-"));
  const run = (cwd, ...a) => execFileSync("git", a, { cwd, encoding: "utf8" });
  run(root, "init", "-q", "--bare", "origin.git");
  const seed = join(root, "seed");
  run(root, "clone", "-q", "origin.git", "seed");
  for (const [k, v] of [
    ["user.email", "t@t.t"],
    ["user.name", "t"],
  ])
    run(seed, "config", k, v);
  mkdirSync(join(seed, "doc/todo"), { recursive: true });
  writeFileSync(join(seed, "doc/todo/053-parent-DONE.md"), "# Parent\n");
  run(seed, "add", "-A");
  run(seed, "commit", "-qm", "base");
  run(seed, "push", "-q", "origin", "HEAD");
  const since = run(seed, "rev-parse", "HEAD").trim();
  writeFileSync(
    join(seed, "doc/todo/054-split.md"),
    "# Split out\n\n## Original Requirement\n\nDo it.\n",
  );
  run(seed, "add", "-A");
  run(seed, "commit", "-qm", "follow-up");
  run(seed, "push", "-q", "origin", "HEAD");

  const clone = (name) => {
    run(root, "clone", "-q", "origin.git", name);
    const path = join(root, name);
    for (const [k, v] of [
      ["user.email", "t@t.t"],
      ["user.name", name],
    ])
      run(path, "config", k, v);
    return path;
  };

  const bin = join(root, "bin");
  mkdirSync(bin);
  writeFileSync(
    join(bin, "gh"),
    `#!/bin/sh\necho x >> "${root}/issues"\necho '{"id":9001,"number":57,"html_url":"https://github.com/o/r/issues/57"}'\n`,
  );
  chmodSync(join(bin, "gh"), 0o755);
  process.env.PATH = `${bin}:${process.env.PATH}`;
  const issues = () =>
    existsSync(join(root, "issues"))
      ? readFileSync(join(root, "issues"), "utf8").split("\n").length - 1
      : 0;
  return { since, dell: clone("dell"), karel: clone("karel"), issues, run };
}

/**
 * An in-memory Hasura holding one board and its cards. The first `racers` card
 * lookups wait for each other, so that many runners all pass the pre-check before
 * any of them inserts — the race the card lock exists for.
 */
function fakeKanban(racers = 1) {
  const cards = [];
  let seq = 0;
  let release;
  const gate = new Promise((r) => (release = r));
  let waiting = 0;
  const kanban = {
    endpoint: "x",
    adminSecret: "s",
    lists: { backlog: "Backlog" },
    cards,
    inserts: 0,
  };
  globalThis.fetch = async (_url, { body }) => {
    const { query, variables: v } = JSON.parse(body);
    await new Promise((r) => setImmediate(r));
    if (query.includes("todos(where") && waiting < racers) {
      if (++waiting === racers) release();
      await gate;
    }
    let data;
    if (query.includes("boards("))
      data = {
        boards: [
          {
            id: "b",
            user_id: "u",
            lists: [{ id: "l-backlog", name: "Backlog" }],
          },
        ],
      };
    else if (query.includes("insert_todos_one")) {
      const card = { ...v.o, id: `c${++seq}` };
      kanban.inserts++;
      cards.push(card);
      data = { insert_todos_one: { id: card.id } };
    } else if (query.includes("delete_todos_by_pk")) {
      cards.splice(
        cards.findIndex((c) => c.id === v.id),
        1,
      );
      data = {};
    } else if (query.includes("update_todos_by_pk")) {
      Object.assign(
        cards.find((c) => c.id === v.id),
        v.set,
      );
      data = {};
    } else
      data = {
        todos: cards
          .filter((c) => c.task_file_path === v.path)
          .map(({ id }) => ({ id })),
      };
    return { json: async () => ({ data }) };
  };
  return kanban;
}

test("files a follow-up as one issue and one card, numbered by the issue, however many runners sweep", async () => {
  const { since, dell, karel, issues, run } = setup();
  const kanban = fakeKanban(2);
  const sweep = (repoPath) =>
    fileFollowUps(kanban, {
      repoName: "o/r",
      repoPath,
      dir: "doc/todo",
      since,
    });

  const lines = (await Promise.all([sweep(dell), sweep(karel)])).flat();

  assert.equal(kanban.inserts, 2, "both runners raced past the pre-check");
  assert.equal(issues(), 1);
  assert.equal(kanban.cards.length, 1);
  assert.deepEqual(lines, ["follow-up 057-split.md → issue #57, Backlog"]);
  assert.deepEqual(
    { ...kanban.cards[0], content: undefined },
    {
      id: kanban.cards[0].id,
      title: "Split out",
      content: undefined,
      list_id: "l-backlog",
      user_id: "u",
      task_file_path: "doc/todo/057-split.md",
      github_issue_number: 57,
      github_issue_id: 9001,
      github_url: "https://github.com/o/r/issues/57",
      github_synced_at: kanban.cards[0].github_synced_at,
    },
  );

  const winner = existsSync(join(dell, "doc/todo/057-split.md")) ? dell : karel;
  assert.match(
    readFileSync(join(winner, "doc/todo/057-split.md"), "utf8"),
    /^_GitHub issue #57 /m,
  );
  assert.equal(run(winner, "status", "--porcelain"), "");
  assert.match(
    run(winner, "log", "-1", "--format=%s"),
    /file follow-up 057-split\.md as #57/,
  );
});

test("leaves files with a card of their own, and repos without a board, alone", async () => {
  const { since, dell, issues, run } = setup();
  writeFileSync(
    join(dell, "doc/todo/055-draft.md"),
    "# D\n\n_From Kanban card `00000000-0000-0000-0000-000000000000`._\n",
  );
  run(dell, "add", "-A");
  run(dell, "commit", "-qm", "draft");
  const kanban = fakeKanban();
  kanban.cards.push({ id: "old", task_file_path: "doc/todo/054-split.md" });

  assert.deepEqual(
    await fileFollowUps(kanban, {
      repoName: "o/r",
      repoPath: dell,
      dir: "doc/todo",
      since,
    }),
    [],
  );
  assert.equal(issues(), 0);
  assert.deepEqual(
    await fileFollowUps(
      {},
      { repoName: "o/r", repoPath: dell, dir: "doc/todo", since },
    ),
    [],
  );
});
