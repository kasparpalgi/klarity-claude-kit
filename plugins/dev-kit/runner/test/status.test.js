import { test } from "node:test";
import assert from "node:assert/strict";
import { STATUS, costIn, openStatus, statusLine } from "../src/status.js";

const CARD = "aaaaaaaa-1111-2222-3333-444455556666";
const at = (h, m) => new Date(2026, 10, 8, h, m).getTime();
const run = { machine: "dell", tier: "Opus 5.5 / xhigh", attempt: 1 };

test("a running line names machine, start, tier and attempt", () => {
  assert.equal(
    statusLine("running", { ...run, startMs: at(14, 2) }),
    "▶ Running on dell since 14:02 · Opus 5.5 / xhigh · attempt 1",
  );
  assert.equal(
    statusLine("finished", {
      ...run,
      startMs: at(14, 2),
      endMs: at(14, 41),
      costUsd: 2.3312,
    }),
    "■ Finished on dell 14:02–14:41 · Opus 5.5 / xhigh · attempt 1 · $2.33",
  );
});

test("every kind of line carries the prefix the Kanban filters on", () => {
  for (const kind of [
    "running",
    "waiting",
    "needs",
    "failed",
    "unfinished",
    "finished",
  ])
    assert.match(statusLine(kind, { ...run, startMs: 0, endMs: 0 }), STATUS);
  assert.doesNotMatch("▶ Running late, will look tomorrow", STATUS);
});

test("reads the cost out of recordUsage's log line", () => {
  assert.equal(
    costIn("usage: claude-opus-5-5 120 in / 40 out → $2.3312"),
    2.3312,
  );
  assert.equal(costIn("usage: no session transcript for this run"), null);
  assert.equal(costIn(null), null);
});

/** An in-memory Hasura holding one board and the card's comments. */
function fakeKanban(comments = []) {
  const calls = [];
  let seq = 0;
  globalThis.fetch = async (_url, { body }) => {
    const { query, variables: v } = JSON.parse(body);
    calls.push(query.match(/^\w+ (\w)/)[1]);
    let data;
    if (query.includes("boards("))
      data = { boards: [{ id: "b", user_id: "u", lists: [] }] };
    else if (query.includes("insert_comments_one")) {
      const c = { id: `c${++seq}`, content: v.body, user_id: v.user };
      comments.push(c);
      data = { insert_comments_one: { id: c.id } };
    } else if (query.includes("update_comments")) {
      const c = comments.find((x) => x.id === v.id);
      c.content = v.body;
      data = { update_comments: { affected_rows: 1 } };
    } else data = { comments: [...comments].reverse() };
    return { json: async () => ({ data }) };
  };
  return { kanban: { endpoint: "x", adminSecret: "s" }, comments, calls };
}

test("posts one comment when the run starts and edits it after, never re-posting", async () => {
  const { kanban, comments } = fakeKanban();
  const say = await openStatus(kanban, {
    ...run,
    repoName: "o/r",
    todoId: CARD,
  });
  assert.equal(comments.length, 1);
  assert.match(comments[0].content, /^▶ Running on dell since/);
  await say("needs");
  await say("finished", { costUsd: 1.5 });
  assert.equal(comments.length, 1);
  assert.match(comments[0].content, /^■ Finished on dell .* · \$1\.50$/);
});

test("a link found mid-run joins the line as it stands, once", async () => {
  const { kanban, comments } = fakeKanban();
  const say = await openStatus(kanban, {
    ...run,
    repoName: "o/r",
    todoId: CARD,
  });
  await say("needs");
  await say.link("https://claude.ai/code/session_01A");
  assert.match(
    comments[0].content,
    /^⏸ Needs you .* · https:\/\/claude\.ai\/code\/session_01A$/,
  );
  await say.link("https://claude.ai/code/session_02B");
  await say("finished", { costUsd: 1 });
  assert.match(
    comments[0].content,
    /^■ Finished .* · \$1\.00 · https:\/\/claude\.ai\/code\/session_01A$/,
  );
});

test("a retry takes over the unfinished attempt's comment; a finished one is kept", async () => {
  const { kanban, comments } = fakeKanban([
    { id: "old", content: "■ Finished on dell 09:00–09:30 · attempt 1" },
    { id: "human", content: "Still broken on mobile." },
    { id: "prev", content: "⚠ Did not finish on dell 10:00–10:20 · attempt 1" },
  ]);
  await openStatus(kanban, {
    ...run,
    attempt: 2,
    repoName: "o/r",
    todoId: CARD,
  });
  assert.equal(comments.length, 3);
  assert.match(comments[2].content, /^▶ Running .* attempt 2$/);

  comments[2].content = "■ Finished on dell 10:30–10:50 · attempt 2";
  await openStatus(kanban, { ...run, repoName: "o/r", todoId: CARD });
  assert.equal(comments.length, 4);
});

test("no Kanban or no card: nothing is posted and nothing throws", async () => {
  const { calls } = fakeKanban();
  const say = await openStatus({}, { ...run, repoName: "o/r", todoId: CARD });
  await say("finished");
  await openStatus(
    { endpoint: "x", adminSecret: "s" },
    { ...run, repoName: "o/r", todoId: null },
  );
  assert.equal(calls.length, 0);
});

test("a Hasura error is a log line, not a failed run", async () => {
  globalThis.fetch = async () => ({
    json: async () => ({ errors: [{ message: "boom" }] }),
  });
  const lines = [];
  const say = await openStatus(
    { endpoint: "x", adminSecret: "s" },
    { ...run, repoName: "o/r", todoId: CARD, log: (l) => lines.push(l) },
  );
  await say("failed");
  assert.deepEqual(lines, ["  status comment: boom", "  status comment: boom"]);
});

test("the Remote Control link, once known, stays on every later line (#85)", async () => {
  const { kanban, comments } = fakeKanban();
  const say = await openStatus(kanban, { ...run, repoName: "o/r", todoId: CARD });
  const url = "https://claude.ai/code/session_01ABC";
  await say("running", { url });
  await say("finished", { costUsd: 1.5 });
  assert.match(comments[0].content, /^■ Finished .* · \$1\.50 · https:\/\/claude\.ai\/code\/session_01ABC$/);
});
