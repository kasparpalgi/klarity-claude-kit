/**
 * The pane path, against a fake `herdr` on PATH. What is worth pinning here is
 * the one bit run.js now branches on: did an agent ever appear in the pane?
 */
import { strict as assert } from "node:assert";
import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { paneLive, runInHerdr } from "../src/herdr.js";

const ok = (r) => `{"result":${r}}`;
const fail = (code) => `echo '{"error":{"code":"${code}"}}' >&2; exit 1`;

/** A herdr whose `agent wait`/`agent start` can be told to fail. */
function fakeHerdr(cases = "", status = "idle") {
  const bin = join(mkdtempSync(join(tmpdir(), "herdr-")), "herdr");
  writeFileSync(
    bin,
    `#!/bin/sh
case "$1 $2" in
${cases}
"tab list") echo '${ok('{"tabs":[]}')}' ;;
"workspace list") echo '${ok('{"workspaces":[{"workspace_id":"w1"}]}')}' ;;
"tab create") echo '${ok('{"root_pane":{"pane_id":"p1"}}')}' ;;
"agent start") echo '${ok("{}")}' ;;
"agent wait") echo '${ok(`{"agent":{"agent_status":"${status}"}}`)}' ;;
"agent prompt") echo '${ok(`{"agent":{"agent_status":"${status}"}}`)}' ;;
"agent read") echo "transcript" ;;
*) exit 1 ;;
esac
`,
  );
  chmodSync(bin, 0o755);
  process.env.HERDR_BIN = bin;
}

const run = (extra = {}) =>
  runInHerdr({
    name: "task-001",
    cwd: "/tmp",
    args: [],
    prompt: "/todo 001",
    taskMs: 5000,
    blockedMs: 1000,
    pollMs: 10,
    ...extra,
  });

/** A pane whose footer shows a background monitor for the first `n` reads. */
function backgroundFor(n, status) {
  const count = join(mkdtempSync(join(tmpdir(), "reads-")), "n");
  writeFileSync(count, "0");
  fakeHerdr(`"agent read") c=$(($(cat ${count}) + 1)); echo $c > ${count}
  if [ $c -le ${n} ]; then echo "done 4:32 PM · 2 shells, 1 monitor still running"; else echo "idle"; fi ;;`, status);
  return () => Number(readFileSync(count, "utf8"));
}

test("a run that reaches an idle agent reports it started", async () => {
  fakeHerdr();
  const r = await run();
  assert.equal(r.started, true);
  assert.equal(r.code, 0);
});

test("a pane that never registers an agent is not a failed run", async () => {
  fakeHerdr(`"agent wait") ${fail("agent_not_found")} ;;`);
  const r = await run();
  assert.equal(r.started, false);
  assert.equal(r.code, 1);
});

test("a pane whose shell is not up yet is not a failed run either", async () => {
  fakeHerdr(`"agent start") ${fail("agent_pane_busy")} ;;`);
  const r = await run();
  assert.equal(r.started, false);
});

test("idle on a background monitor is waited out, not finished", async () => {
  const reads = backgroundFor(2);
  const r = await run();
  assert.equal(r.code, 0);
  // two busy footers, one clear one, then the transcript for the log
  assert.equal(reads(), 4);
});

test("an unseen pane reports `done`, not `idle`, and is waited out the same", async () => {
  const reads = backgroundFor(2, "done");
  const r = await run();
  assert.equal(r.code, 0);
  assert.equal(reads(), 4);
});

test("a done task is not held open by a lingering background shell", async () => {
  const reads = backgroundFor(99);
  await run({ done: () => true });
  assert.equal(reads(), 1);
});

test("reap spares a live task pane and closes a finished one", async () => {
  const closed = join(mkdtempSync(join(tmpdir(), "closed-")), "log");
  writeFileSync(closed, "");
  const tabs = JSON.stringify({
    tabs: [
      { label: "task-034", tab_id: "live", agent_status: "working" },
      { label: "task-033", tab_id: "asking", agent_status: "blocked" },
      { label: "task-032", tab_id: "old", agent_status: "done" },
    ],
  });
  fakeHerdr(`"tab list") echo '${ok(tabs)}' ;;
"tab close") echo "$3" >> ${closed}; echo '${ok("{}")}' ;;`);
  await run();
  assert.deepEqual(readFileSync(closed, "utf8").trim().split("\n"), ["old"]);
  assert.equal(await paneLive("task-034"), true);
  assert.equal(await paneLive("task-032"), false);
});
