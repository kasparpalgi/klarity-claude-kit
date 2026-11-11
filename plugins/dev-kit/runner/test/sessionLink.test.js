import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { bridgeUrl, watchLink } from "../src/sessionLink.js";

const BRIDGE = JSON.stringify({
  type: "bridge-session",
  sessionId: "34882ee8",
  bridgeSessionId: "cse_01QuJYrTuf94FzX2Jgx5Zyr1",
});

test("the bridge-session line's cse_ id is the session_ in the link", () => {
  assert.equal(
    bridgeUrl(`{"type":"user"}\n${BRIDGE}\n`),
    "https://claude.ai/code/session_01QuJYrTuf94FzX2Jgx5Zyr1",
  );
  assert.equal(bridgeUrl('{"type":"user"}\n'), null);
  assert.equal(bridgeUrl(null), null);
});

test("watches until the transcript names the session, then reports it once", async () => {
  const dir = mkdtempSync(join(tmpdir(), "link-"));
  const urls = [];
  const stop = watchLink({
    dir,
    sinceMs: Date.now() - 1000,
    onUrl: (u) => urls.push(u),
    everyMs: 10,
  });
  await new Promise((r) => setTimeout(r, 30)); // no transcript yet: quiet
  writeFileSync(join(dir, "s.jsonl"), '{"type":"user"}\n');
  await new Promise((r) => setTimeout(r, 30));
  assert.deepEqual(urls, []);
  writeFileSync(join(dir, "s.jsonl"), `{"type":"user"}\n${BRIDGE}\n`);
  await new Promise((r) => setTimeout(r, 50));
  stop();
  assert.deepEqual(urls, [
    "https://claude.ai/code/session_01QuJYrTuf94FzX2Jgx5Zyr1",
  ]);
});

test("gives up when the session never joins claude.ai", async () => {
  const dir = mkdtempSync(join(tmpdir(), "link-"));
  writeFileSync(join(dir, "s.jsonl"), '{"type":"user"}\n');
  const urls = [];
  watchLink({
    dir,
    sinceMs: 0,
    onUrl: (u) => urls.push(u),
    everyMs: 5,
    tries: 2,
  });
  await new Promise((r) => setTimeout(r, 40));
  writeFileSync(join(dir, "s.jsonl"), `${BRIDGE}\n`);
  await new Promise((r) => setTimeout(r, 40));
  assert.deepEqual(urls, []);
});
