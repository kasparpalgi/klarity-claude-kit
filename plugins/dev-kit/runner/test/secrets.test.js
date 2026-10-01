import { test } from "node:test";
import assert from "node:assert/strict";
import { isSecret, parseSums, stale } from "../src/secrets.js";

test("isSecret: .env files and the two named extras, never the templates", () => {
  for (const p of [
    ".env",
    ".env.local",
    ".env.test",
    "codegen/.env",
    "hasura/config.yaml",
    ".secrets/",
  ])
    assert.ok(isSecret(p), p);
  for (const p of [
    ".env.example",
    "app/.env.sample",
    "node_modules/",
    "config.yaml",
    "x/hasura/config.yaml",
    "src/env.ts",
  ])
    assert.ok(!isSecret(p), p);
});

const A = "a".repeat(64);
const B = "b".repeat(64);

test("parseSums: per repo index, clone marker and hashes", () => {
  const out = parseSums(
    `0 ok\n0 ${A}  .env\n0 ${B}  .secrets/key.json\n2 ok\nnoise\n`,
  );
  assert.deepEqual(out[0], {
    ok: true,
    sums: { ".env": A, ".secrets/key.json": B },
  });
  assert.equal(out[1], undefined); // no clone there: nothing printed
  assert.deepEqual(out[2], { ok: true, sums: {} });
});

test("stale: missing or different on the peer; peer-only files ignored", () => {
  assert.deepEqual(
    stale({ ".env": A, ".env.local": A }, { ".env": A, ".env.peer": B }),
    [".env.local"],
  );
  assert.deepEqual(stale({ ".env": A }, { ".env": B }), [".env"]);
  assert.deepEqual(stale({ ".env": A }, { ".env": A }), []);
});
