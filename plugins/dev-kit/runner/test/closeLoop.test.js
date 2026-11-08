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

  globalThis.fetch = async (_url, { body }) => {
    if (kanbanDown) throw new Error("Hasura down");
    const { query } = JSON.parse(body);
    appendFileSync(calls, `kanban ${query.match(/^\w+ (\w+)/)[1]}\n`);
    const data = query.includes("boards(")
      ? {
          boards: [
            { id: "b", user_id: "u", lists: [{ id: "r", name: "Review" }] },
          ],
        }
      : query.includes("comments(")
        ? { comments: [] }
        : {};
    return { json: async () => ({ data }) };
  };
  const kanban = {
    endpoint: "x",
    adminSecret: "s",
    lists: { review: "Review" },
  };
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
      order.indexOf("kanban S") < order.indexOf("gh issue comment"),
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
  assert.ok(lines.some((l) => l.startsWith("kanban: Hasura down")));
});
