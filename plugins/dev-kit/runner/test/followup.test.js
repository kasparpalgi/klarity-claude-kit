import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileFollowUps, issueName, withIssue } from "../src/followup.js";
import { fakeKanban, setup } from "./followup.fixture.js";

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
