import { test } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, existsSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileFollowUps } from "../src/followup.js";
import { fakeKanban, setup } from "./followup.fixture.js";

const sweep = (kanban, repoPath, since) =>
  fileFollowUps(kanban, { repoName: "o/r", repoPath, dir: "doc/todo", since });

test("origin moved on: the winner replays onto it, and a stale runner does not file it again", async () => {
  const { since, dell, karel, issues, run } = setup();
  const seed = join(dirname(dell), "seed");
  writeFileSync(join(seed, "other.txt"), "x\n");
  run(seed, "add", "-A");
  run(seed, "commit", "-qm", "someone else");
  run(seed, "push", "-q", "origin", "HEAD");
  const kanban = fakeKanban();

  assert.deepEqual(await sweep(kanban, karel, since), [
    "follow-up 057-split.md → issue #57, Backlog",
  ]);
  assert.equal(run(karel, "rev-list", "--count", "@{u}..HEAD").trim(), "0");
  assert.equal(kanban.cards[0].task_file_path, "doc/todo/057-split.md");

  // Dell never pulled: it still has 054, and no card is at that path any more.
  assert.deepEqual(await sweep(kanban, dell, since), []);
  assert.equal(issues(), 1);
  assert.equal(kanban.cards.length, 1);
});

test("a push origin refuses is undone, and the card keeps the old path", async () => {
  const { since, karel, issues, run } = setup();
  const hook = join(dirname(karel), "origin.git/hooks/pre-receive");
  writeFileSync(hook, "#!/bin/sh\nexit 1\n");
  chmodSync(hook, 0o755);
  const kanban = fakeKanban();

  const [line] = await sweep(kanban, karel, since);
  assert.match(
    line,
    /push failed — left unrenamed, the card keeps doc\/todo\/054/,
  );
  assert.equal(issues(), 1);
  assert.equal(run(karel, "status", "--porcelain"), "");
  assert.equal(run(karel, "rev-list", "--count", "@{u}..HEAD").trim(), "0");
  assert.ok(existsSync(join(karel, "doc/todo/054-split.md")));
  assert.equal(kanban.cards[0].task_file_path, "doc/todo/054-split.md");
  assert.equal(kanban.cards[0].github_issue_number, 57);
});
