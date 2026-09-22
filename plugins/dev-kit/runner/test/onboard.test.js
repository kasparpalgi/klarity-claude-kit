import { test } from "node:test";
import assert from "node:assert/strict";
import { dirFor, findClone, missing, onboard, originOf, repoOf } from "../src/onboard.js";
import { loadConfig } from "../src/config.js";
import { readFileSync } from "node:fs";
import { claudeMd, mergeSettings, stackOf } from "../src/scaffold.js";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

test("repoOf reads the JSON the board stores in its text column", () => {
  assert.equal(
    repoOf('{"owner":"kasparpalgi","repo":"kusp","full_name":"kasparpalgi/kusp"}'),
    "kasparpalgi/kusp",
  );
  assert.equal(repoOf({ owner: "ezy-rent", repo: "ezy-iot" }), "ezy-rent/ezy-iot");
});

test("a board with no repo, or junk in the column, is skipped not guessed", () => {
  assert.equal(repoOf(null), null);
  assert.equal(repoOf("not json"), null);
  assert.equal(repoOf('{"owner":"x"}'), null);
  assert.equal(repoOf('{"full_name":"https://github.com/x/y"}'), null);
});

test("a client's board lands under customers/, everything else at the root", () => {
  assert.equal(dirFor("kasparpalgi/kusp", false), "~/Documents/GitHub/kusp");
  assert.equal(dirFor("kasparpalgi/kusp", true), "~/Documents/GitHub/customers/kusp");
  assert.equal(dirFor("a/b", true, "/code"), "/code/customers/b");
});

test("missing() leaves a repo the config already places by hand alone", () => {
  const repos = { "ezy-rent/ezy-iot": "~/Documents/GitHub/ezy/ezy-iot" };
  const boards = [
    { name: "EZY IoT", github: '{"full_name":"ezy-rent/ezy-iot"}', client_id: null },
    { name: "Work", github: '{"full_name":"kasparpalgi/job"}', client_id: "c1" },
  ];
  assert.deepEqual(missing(repos, boards), [
    { repo: "kasparpalgi/job", board: "Work", hasClient: true },
  ]);
});

test("the config's own spelling of a repo counts, whatever its case", () => {
  const boards = [{ name: "B", github: '{"full_name":"Kasparpalgi/Kusp"}', client_id: null }];
  assert.deepEqual(missing({ "kasparpalgi/kusp": "~/x" }, boards), []);
});

test("two boards on one repo onboard it once", () => {
  const boards = [
    { name: "A", github: '{"full_name":"x/y"}', client_id: null },
    { name: "B", github: '{"full_name":"x/y"}', client_id: null },
  ];
  assert.equal(missing({}, boards).length, 1);
});

test("mergeSettings enables the plugin without dropping what is there", () => {
  const next = mergeSettings({ enabledPlugins: { "other@x": true }, permissions: { allow: ["Bash"] } });
  assert.equal(next.enabledPlugins["dev-kit@klarity"], true);
  assert.equal(next.enabledPlugins["other@x"], true);
  assert.deepEqual(next.permissions, { allow: ["Bash"] });
  assert.equal(next.extraKnownMarketplaces.klarity.source.repo, "kasparpalgi/klarity-claude-kit");
});

test("mergeSettings on an already-onboarded repo is a no-op", () => {
  const once = mergeSettings({});
  assert.deepEqual(mergeSettings(once), once);
});

test("stackOf prefers the lockfile over the package.json beside it", () => {
  const dir = mkdtempSync(join(tmpdir(), "onboard-"));
  writeFileSync(join(dir, "package.json"), "{}");
  assert.equal(stackOf(dir).name, "Node");
  writeFileSync(join(dir, "package-lock.json"), "{}");
  assert.deepEqual(stackOf(dir).install, ["npm", "ci"]);
});

test("stackOf on a repo it does not recognise installs nothing", () => {
  const dir = mkdtempSync(join(tmpdir(), "onboard-"));
  assert.equal(stackOf(dir).name, "unknown");
  assert.equal(stackOf(dir).install, null);
});

test("the CLAUDE.md stub names the repo, the stack and the /todo workflow", () => {
  const md = claudeMd("x/y", "Node (npm)");
  assert.match(md, /\*\*Repo\*\*: x\/y/);
  assert.match(md, /\*\*Stack\*\*: Node \(npm\)/);
  assert.match(md, /`\/todo <number>`/);
  assert.match(md, /doc\/todo\//);
});

const clone = (dir, url) => {
  mkdirSync(join(dir, ".git"), { recursive: true });
  writeFileSync(join(dir, ".git", "config"), `[core]\n\tbare = false\n[remote "origin"]\n\turl = ${url}\n`);
  return dir;
};

test("originOf reads the origin remote, ssh or https, .git or not", () => {
  const root = mkdtempSync(join(tmpdir(), "clones-"));
  assert.equal(originOf(clone(join(root, "a"), "git@github.com:x/y.git")), "x/y");
  assert.equal(originOf(clone(join(root, "b"), "https://github.com/x/y")), "x/y");
  assert.equal(originOf(join(root, "nope")), null);
});

test("originOf ignores a url that belongs to another remote", () => {
  const root = mkdtempSync(join(tmpdir(), "clones-"));
  const dir = join(root, "a");
  mkdirSync(join(dir, ".git"), { recursive: true });
  writeFileSync(join(dir, ".git", "config"), '[remote "upstream"]\n\turl = git@github.com:up/stream.git\n');
  assert.equal(originOf(dir), null);
});

test("findClone finds the repo wherever it was filed by hand", () => {
  const root = mkdtempSync(join(tmpdir(), "clones-"));
  clone(join(root, "ezy", "ezy-iot"), "git@github.com:ezy-rent/ezy-iot.git");
  clone(join(root, "customers", "life-effect", "life-effect-front"), "https://github.com/life-effect/life-effect-front");
  assert.equal(findClone(root, "ezy-rent/ezy-iot"), join(root, "ezy", "ezy-iot"));
  assert.equal(findClone(root, "LIFE-EFFECT/Life-Effect-Front"), join(root, "customers", "life-effect", "life-effect-front"));
  assert.equal(findClone(root, "x/never-cloned"), null);
});

/** A config.json on disk plus a fetch that answers the BOARDS query with `boards`. */
function fixture(boards, extra = {}) {
  const root = mkdtempSync(join(tmpdir(), "onboard-"));
  const path = join(root, "config.json");
  writeFileSync(
    path,
    JSON.stringify({ endpoint: "http://x/v1/graphql", adminSecret: "s", repos: {}, codeRoot: root, ...extra }),
  );
  globalThis.fetch = async () => ({ json: async () => ({ data: { boards } }) });
  return { root, path };
}

test("onboard --dry-run plans the missing board and writes no config", async () => {
  const { root, path } = fixture([
    { name: "Kirjanduse Selts", github: '{"full_name":"kasparpalgi/kirjanduse-selts"}', client_id: "c1" },
  ]);
  const r = await onboard({ configPath: path, dryRun: true, peers: false, log: () => {} });
  assert.deepEqual(
    r.todo.map((t) => [t.repo, t.dir, t.isNew]),
    [["kasparpalgi/kirjanduse-selts", `${root}/customers/kirjanduse-selts`, true]],
  );
  assert.deepEqual(r.landed, []);
  assert.deepEqual(JSON.parse(readFileSync(path, "utf8")).repos, {});
});

test("a board already in repos is left alone — no re-scaffold, no rewrite", async () => {
  const { path } = fixture(
    [{ name: "Kusp", github: '{"full_name":"kasparpalgi/kusp"}', client_id: null }],
    { repos: { "kasparpalgi/kusp": "~/elsewhere/kusp" } },
  );
  const r = await onboard({ configPath: path, dryRun: true, peers: false, log: () => {} });
  assert.deepEqual(r.todo, []);
  assert.equal(JSON.parse(readFileSync(path, "utf8")).repos["kasparpalgi/kusp"], "~/elsewhere/kusp");
});

test("the daemon sweeps for new boards every 5 minutes unless told otherwise", () => {
  const { path } = fixture([], { repos: { "a/b": "/tmp/b" } });
  assert.equal(loadConfig(path).onboardMinutes, 5);
  const off = join(mkdtempSync(join(tmpdir(), "cfg-")), "config.json");
  writeFileSync(off, JSON.stringify({ repos: { "a/b": "/tmp/b" }, onboardMinutes: 0 }));
  assert.equal(loadConfig(off).onboardMinutes, 0);
});
