/**
 * The pane path, against a fake `herdr` on PATH. What is worth pinning here is
 * the one bit run.js now branches on: did an agent ever appear in the pane?
 */
import { strict as assert } from "node:assert";
import { chmodSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { runInHerdr } from "../src/herdr.js";

const ok = (r) => `{"result":${r}}`;
const fail = (code) => `echo '{"error":{"code":"${code}"}}' >&2; exit 1`;

/** A herdr whose `agent wait`/`agent start` can be told to fail. */
function fakeHerdr(cases = "") {
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
"agent wait") echo '${ok('{"agent":{"agent_status":"idle"}}')}' ;;
"agent prompt") echo '${ok('{"agent":{"agent_status":"idle"}}')}' ;;
"agent read") echo "transcript" ;;
*) exit 1 ;;
esac
`,
  );
  chmodSync(bin, 0o755);
  process.env.HERDR_BIN = bin;
}

const run = () =>
  runInHerdr({
    name: "task-001",
    cwd: "/tmp",
    args: [],
    prompt: "/todo 001",
    taskMs: 5000,
    blockedMs: 1000,
  });

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
