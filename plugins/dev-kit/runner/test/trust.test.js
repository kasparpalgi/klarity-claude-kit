import { strict as assert } from "node:assert";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { trustProject } from "../src/trust.js";

const scratch = () => mkdtempSync(join(tmpdir(), "trust-"));

test("trusts a folder Claude has never seen, keeping the rest of the config", () => {
  const path = join(scratch(), ".claude.json");
  writeFileSync(path, JSON.stringify({ numStartups: 7, projects: { "/a": { x: 1 } } }));

  assert.equal(trustProject("/repo", path), true);
  const cfg = JSON.parse(readFileSync(path, "utf8"));
  assert.equal(cfg.projects["/repo"].hasTrustDialogAccepted, true);
  assert.deepEqual(cfg.projects["/a"], { x: 1 });
  assert.equal(cfg.numStartups, 7);
});

test("writes nothing the second time, and keeps the project's other settings", () => {
  const path = join(scratch(), ".claude.json");
  writeFileSync(path, JSON.stringify({ projects: { "/repo": { lastCost: 3 } } }));

  assert.equal(trustProject("/repo", path), true);
  assert.equal(trustProject("/repo", path), false);
  assert.equal(JSON.parse(readFileSync(path, "utf8")).projects["/repo"].lastCost, 3);
});

test("resolves the path the way Claude keys it", () => {
  const path = join(scratch(), ".claude.json");
  writeFileSync(path, "{}");

  trustProject("/repo/sub/..", path);
  assert.ok(JSON.parse(readFileSync(path, "utf8")).projects["/repo"]);
});

test("leaves a config it cannot parse alone", () => {
  const path = join(scratch(), ".claude.json");
  writeFileSync(path, "{ half-written");

  assert.equal(trustProject("/repo", path), false);
  assert.equal(readFileSync(path, "utf8"), "{ half-written");
});

test("creates the config when the machine has none yet", () => {
  const path = join(scratch(), ".claude.json");

  assert.equal(trustProject("/repo", path), true);
  assert.equal(JSON.parse(readFileSync(path, "utf8")).projects["/repo"].hasTrustDialogAccepted, true);
});
