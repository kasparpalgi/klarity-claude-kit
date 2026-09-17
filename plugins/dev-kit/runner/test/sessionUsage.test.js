import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  costOf,
  findSessionFile,
  recordUsage,
  slugFor,
  sumUsage,
  totalsOf,
} from "../src/sessionUsage.js";

const assistant = (id, model, u, timestamp) =>
  JSON.stringify({
    type: "assistant",
    timestamp,
    requestId: `req_${id}`,
    message: { id, model, usage: u },
  });

const use = (input, output, cacheRead, cacheWrite) => ({
  input_tokens: input,
  output_tokens: output,
  cache_read_input_tokens: cacheRead,
  cache_creation_input_tokens: cacheWrite,
});

const PRICING = {
  "claude-opus-4-8": {
    input_per_mtok: 5,
    output_per_mtok: 25,
    cache_read_per_mtok: 0.5,
    cache_write_per_mtok: 6.25,
  },
  "claude-sonnet-5": {
    input_per_mtok: 2,
    output_per_mtok: 10,
    cache_read_per_mtok: 0.2,
    cache_write_per_mtok: 2.5,
  },
};

test("slugFor matches Claude Code's project folder names", () => {
  assert.equal(
    slugFor("/Users/klarity/Documents/GitHub/svelte-hasura-boilerplate"),
    "-Users-klarity-Documents-GitHub-svelte-hasura-boilerplate",
  );
  // Dots, underscores and an already-dashed segment all collapse the same way.
  assert.equal(slugFor("/tmp/a.b_c-d"), "-tmp-a-b-c-d");
});

test("sumUsage dedupes a reply repeated per content block", () => {
  const line = assistant("msg_1", "claude-opus-4-8", use(2, 100, 500, 40));
  const { byModel } = sumUsage([line, line, line]);
  assert.deepEqual(byModel, {
    "claude-opus-4-8": { input: 2, output: 100, cacheRead: 500, cacheWrite: 40 },
  });
});

test("sumUsage groups a model switch and brackets the run", () => {
  const { byModel, startedAt, endedAt } = sumUsage([
    assistant("a", "claude-opus-4-8", use(1, 10, 100, 5), "2026-09-17T10:00:00Z"),
    assistant("b", "claude-sonnet-5", use(3, 30, 300, 15), "2026-09-17T10:05:00Z"),
    "not json at all",
    JSON.stringify({ type: "user", timestamp: "2026-09-17T10:09:00Z" }),
  ]);
  assert.deepEqual(Object.keys(byModel), ["claude-opus-4-8", "claude-sonnet-5"]);
  assert.equal(startedAt, "2026-09-17T10:00:00Z");
  assert.equal(endedAt, "2026-09-17T10:09:00Z");
  assert.deepEqual(totalsOf(byModel), {
    input: 4,
    output: 40,
    cacheRead: 400,
    cacheWrite: 20,
  });
});

test("costOf prices each slice and names the dominant model", () => {
  const { byModel } = sumUsage([
    assistant("a", "claude-opus-4-8", use(0, 1e6, 0, 0)),
    assistant("b", "claude-sonnet-5", use(0, 1e6, 0, 0)),
  ]);
  const { costUsd, model, missing } = costOf(byModel, PRICING);
  assert.equal(costUsd, 35); // 25 (opus) + 10 (sonnet)
  assert.equal(model, "claude-opus-4-8");
  assert.deepEqual(missing, []);
});

test("costOf tolerates a dated id and an unpriced model", () => {
  const { byModel } = sumUsage([
    assistant("a", "claude-sonnet-5-20260101", use(0, 1e6, 0, 0)),
    assistant("b", "claude-opus-9-brand-new", use(0, 2e6, 0, 0)),
  ]);
  const { costUsd, model, missing } = costOf(byModel, PRICING);
  assert.equal(costUsd, 10); // only the dated sonnet is priced
  assert.equal(model, "claude-sonnet-5-20260101");
  assert.deepEqual(missing, ["claude-opus-9-brand-new"]);
});

test("findSessionFile takes the newest transcript touched by the run", () => {
  const dir = mkdtempSync(join(tmpdir(), "sessions-"));
  writeFileSync(join(dir, "old.jsonl"), "{}");
  const old = Date.now() / 1000 - 3600;
  utimesSync(join(dir, "old.jsonl"), old, old);
  const since = Date.now() - 1;
  writeFileSync(join(dir, "new.jsonl"), "{}");
  writeFileSync(join(dir, "ignored.txt"), "{}");
  assert.equal(findSessionFile(dir, since), join(dir, "new.jsonl"));
  assert.equal(findSessionFile(dir, Date.now() + 60000), null);
  assert.equal(findSessionFile(join(dir, "nope"), 0), null);
});

const KANBAN = { endpoint: "http://x/v1/graphql", adminSecret: "s" };

function stubGql(sent) {
  return async (_kanban, query, vars) => {
    sent.push({ query, vars });
    if (query.includes("claude_model_pricing"))
      return {
        claude_model_pricing: Object.entries(PRICING).map(([model, p]) => ({
          model,
          ...p,
        })),
      };
    if (query.includes("boards")) return { boards: [{ user_id: "user-1" }] };
    return { insert_claude_usage_one: { id: "row-1" } };
  };
}

test("recordUsage upserts one row for the session", async () => {
  const dir = mkdtempSync(join(tmpdir(), "-Users-x-repo-"));
  const since = Date.now() - 1000;
  writeFileSync(
    join(dir, "sess-abc.jsonl"),
    [
      assistant("a", "claude-opus-4-8", use(0, 1e6, 0, 0), "2026-09-17T10:00:00Z"),
      assistant("a", "claude-opus-4-8", use(0, 1e6, 0, 0), "2026-09-17T10:00:00Z"),
    ].join("\n"),
  );
  const sent = [];
  // The real call derives the dir from repoPath; point it at the fixture instead.
  const line = await recordUsage(
    KANBAN,
    { repoName: "me/repo", repoPath: "/x", todoId: "card-1", sinceMs: since, dir },
    stubGql(sent),
  );
  assert.match(line, /claude-opus-4-8/);
  assert.match(line, /\$25\.0000/);
  const { row } = sent.at(-1).vars;
  assert.equal(row.session_id, "sess-abc");
  assert.equal(row.todo_id, "card-1");
  assert.equal(row.user_id, "user-1");
  assert.equal(row.output_tokens, 1e6); // deduped, not 2e6
  assert.equal(row.cost_usd, 25);
  assert.equal(row.started_at, "2026-09-17T10:00:00Z");
});

test("recordUsage stays quiet when there is nothing to record", async () => {
  const dir = mkdtempSync(join(tmpdir(), "empty-"));
  assert.equal(await recordUsage({}, { repoPath: "/x", dir, sinceMs: 0 }), null);
  assert.match(
    await recordUsage(
      KANBAN,
      { repoName: "me/repo", repoPath: "/x", dir, sinceMs: Date.now() + 60000 },
      stubGql([]),
    ),
    /no session transcript/,
  );
});
