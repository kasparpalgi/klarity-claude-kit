import { test } from "node:test";
import assert from "node:assert/strict";
import {
  appendFileSync,
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { KANBAN, fakeApi } from "./fakeApi.js";
import { closeLoop } from "../src/kanban.js";

const CARD = "951ba857-ccf1-4cfa-9e97-cb85420071a0";
const DONE = `# Comments 2x

_From Kanban card \`${CARD}\`, moved to the agent list._

_GitHub issue #80 — end the commit subject with \`(#80)\`._

## Results

**Summary** — once.
`;

/** A repo with one finished task, a `gh` that logs to `calls`, and a Kanban that does too. */
function world({ kanbanDown = false } = {}) {
  const root = mkdtempSync(join(tmpdir(), "closeloop-"));
  mkdirSync(join(root, "doc/todo"), { recursive: true });
  writeFileSync(join(root, "doc/todo/080-comments2x-DONE.md"), DONE);
  const calls = join(root, "calls");
  writeFileSync(calls, "");
  const bin = join(root, "bin");
  mkdirSync(bin);
  writeFileSync(
    join(bin, "gh"),
    `#!/bin/sh\necho "gh $1 $2" >> "${calls}"\n[ "$2" = view ] && echo '{"state":"OPEN"}'\nexit 0\n`,
  );
  chmodSync(join(bin, "gh"), 0o755);
  process.env.PATH = `${bin}${delimiter}${process.env.PATH}`;

  const say = (op, data) => () => {
    if (kanbanDown) throw new Error("Kanban down");
    appendFileSync(calls, `kanban ${op}\n`);
    return data;
  };
  fakeApi({
    board: say("board", {
      id: "b",
      user_id: "u",
      lists: [{ id: "r", name: "Review" }],
    }),
    cards: say("cards", []),
    comments: say("comments", []),
    updateCard: say("updateCard", { updated: true }),
    createComment: say("createComment", { id: "c" }),
    uploads: say("uploads", []),
  });
  const kanban = { ...KANBAN, lists: { review: "Review" } };
  const run = () =>
    closeLoop(kanban, {
      repoName: "o/r",
      repoPath: root,
      dir: "doc/todo",
      stem: "080-comments2x",
      blocked: false,
    });
  return { run, log: () => readFileSync(calls, "utf8").trim().split("\n") };
}

const posix = {
  skip: process.platform === "win32" && "fake gh is a sh script",
};

test(
  "the Results land on the card before they are commented on the issue",
  posix,
  async () => {
    // Issue first, the Kanban's copy of the issue comment raced the runner's own
    // insert, and the card showed its Results twice (svelte-hasura-boilerplate#80).
    const { run, log } = world();
    const lines = await run();
    const order = log();
    assert.ok(
      order.indexOf("kanban createComment") < order.indexOf("gh issue comment"),
      order.join(" → "),
    );
    assert.ok(lines.includes("issue #80 commented and closed"));
    assert.ok(lines.includes("card → Review, results posted"));
  },
);

test("a Kanban that is down still gets the issue closed", posix, async () => {
  const { run, log } = world({ kanbanDown: true });
  const lines = await run();
  assert.ok(log().includes("gh issue close"));
  assert.ok(lines.some((l) => l.startsWith("kanban: board: Kanban down")));
});
