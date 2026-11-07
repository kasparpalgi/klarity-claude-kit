import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const tmp = mkdtempSync(join(tmpdir(), "rename-"));
process.env.KANBAN_RUNNER_STATE = join(tmp, "state.json");
process.env.KANBAN_RUNNER_ARCHIVE = join(tmp, "archived");
Object.assign(process.env, {
  GIT_AUTHOR_NAME: "t",
  GIT_AUTHOR_EMAIL: "t@t",
  GIT_COMMITTER_NAME: "t",
  GIT_COMMITTER_EMAIL: "t@t",
});
const { canonicalName, matchName, renameInConfig, resolver } =
  await import("../src/canonical.js");
const { onboard } = await import("../src/onboard.js");
const { offboard } = await import("../src/offboard.js");
const state = await import("../src/state.js");

// `old/app` was transferred to `new/app`, the way GitHub answers it.
const OLD = "old/app";
const NEW = "new/app";
const github = async (repo) =>
  ({ "old/app": NEW, "new/app": NEW, "other/thing": "other/thing" })[
    repo.toLowerCase()
  ] ?? null;
const unreachable = async () => {
  throw new Error("cannot ask GitHub");
};

const git = (args, cwd) => execFileSync("git", args, { cwd, stdio: "pipe" });

/** A real clone at `<root>/<path>`, with a pushed commit and an origin named `origin`. */
function clone(root, path, origin) {
  const bare = join(root, "remotes", `${origin}.git`);
  mkdirSync(bare, { recursive: true });
  git(["init", "-q", "--bare", "-b", "main", bare], root);
  const dir = join(root, path);
  mkdirSync(dir, { recursive: true });
  git(["clone", "-q", bare, dir], root);
  writeFileSync(join(dir, ".gitignore"), ".env\n");
  writeFileSync(join(dir, ".env"), "KEY=1\n");
  git(["add", "."], dir);
  git(["commit", "-qm", "init"], dir);
  git(["push", "-q", "origin", "main"], dir);
  return dir;
}

/** A code root and config.json, and a fetch that records what the Kanban was told. */
function fixture(boardRepo, extra = {}) {
  const root = mkdtempSync(join(tmp, "root-"));
  const code = join(root, "code");
  mkdirSync(code);
  const path = join(root, "config.json");
  writeFileSync(
    path,
    JSON.stringify({
      endpoint: "http://x/v1/graphql",
      adminSecret: "s",
      repos: {},
      codeRoot: code,
      ...extra,
    }),
  );
  const board = {
    id: "b1",
    name: "App",
    client_id: null,
    archived_at: null,
    github: JSON.stringify({
      owner: boardRepo.split("/")[0],
      repo: boardRepo.split("/")[1],
      full_name: boardRepo,
      seo: true,
    }),
  };
  const writes = [];
  globalThis.fetch = async (_url, { body }) => {
    const { query, variables } = JSON.parse(body);
    if (query.startsWith("mutation")) writes.push(variables);
    return { json: async () => ({ data: { boards: [board] } }) };
  };
  return { root, code, path, board, writes };
}

const quiet = { peers: false, install: false, log: () => {} };
const config = (path) => JSON.parse(readFileSync(path, "utf8"));

test("the incident: board says the old name, clone says the new one — adopt it", async () => {
  const { root, code, path, writes } = fixture(OLD);
  const real = clone(root, "code/customers/tektok", NEW);

  const r = await onboard({ configPath: path, ...quiet, lookup: github });

  assert.deepEqual(r.failed, []);
  assert.deepEqual(
    r.landed.map((l) => [l.repo, l.found]),
    [[NEW, true]],
  );
  assert.equal(config(path).repos[NEW], real);
  assert.equal(config(path).repos[OLD], undefined);
  assert.deepEqual(readdirSync(code), ["customers"], "no second clone");
  assert.equal(readFileSync(join(real, ".env"), "utf8"), "KEY=1\n");
  // The board now matches, and keeps what else it stored.
  assert.deepEqual(JSON.parse(writes[0].github), {
    owner: "new",
    repo: "app",
    full_name: NEW,
    seo: true,
  });
});

test("the other way round: board says the new name, clone still says the old one", async () => {
  const { root, code, path, writes } = fixture(NEW);
  const real = clone(root, "code/customers/tektok", OLD);

  const r = await onboard({ configPath: path, ...quiet, lookup: github });

  assert.deepEqual(
    r.landed.map((l) => l.found),
    [true],
  );
  assert.equal(config(path).repos[NEW], real);
  assert.deepEqual(readdirSync(code), ["customers"], "no second clone");
  assert.deepEqual(writes, [], "the board was already right");
});

test("a second sweep after adoption does nothing", async () => {
  const { root, path } = fixture(NEW);
  clone(root, "code/customers/tektok", OLD);
  await onboard({ configPath: path, ...quiet, lookup: github });
  const again = await onboard({
    configPath: path,
    ...quiet,
    lookup: unreachable, // nothing left to ask
  });
  assert.deepEqual(again.todo, []);
  assert.deepEqual(again.failed, []);
});

test("config under the old name moves to the new one, with its lists, and no re-clone", async () => {
  const { path } = fixture(NEW, {
    repos: { [OLD]: "~/hand/placed" },
    pullRequests: [OLD, "x/y"],
    seo: [OLD],
  });

  const r = await onboard({ configPath: path, ...quiet, lookup: github });

  assert.deepEqual(r.todo, []);
  const file = config(path);
  assert.deepEqual(file.repos, { [NEW]: "~/hand/placed" });
  assert.deepEqual(file.pullRequests, [NEW, "x/y"]);
  assert.deepEqual(file.seo, [NEW]);
});

test("config under the new name stays, and the stale board is corrected", async () => {
  const { path, writes } = fixture(OLD, { repos: { [NEW]: "~/real" } });
  const r = await onboard({ configPath: path, ...quiet, lookup: github });
  assert.deepEqual(r.todo, []);
  assert.deepEqual(config(path).repos, { [NEW]: "~/real" });
  assert.equal(JSON.parse(writes[0].github).full_name, NEW);
});

test("--dry-run plans the adoption and writes nothing", async () => {
  const { root, path, writes } = fixture(OLD);
  clone(root, "code/customers/tektok", NEW);
  const r = await onboard({
    configPath: path,
    ...quiet,
    dryRun: true,
    lookup: github,
  });
  assert.deepEqual(
    r.todo.map((t) => [t.repo, t.found]),
    [[NEW, true]],
  );
  assert.deepEqual(config(path).repos, {});
  assert.deepEqual(writes, []);
});

test("GitHub out of reach: report it, clone nothing, try again next sweep", async () => {
  const { code, path } = fixture(OLD);
  const r = await onboard({ configPath: path, ...quiet, lookup: unreachable });
  assert.deepEqual(r.todo, []);
  assert.deepEqual(
    r.failed.map((f) => f.repo),
    [OLD],
  );
  assert.deepEqual(readdirSync(code), []);
  assert.deepEqual(config(path).repos, {});
});

test("a repo GitHub does not know keeps the board's name and is not matched by guesswork", async () => {
  const { root, path, writes } = fixture("gone/repo");
  clone(root, "code/other", "other/thing");
  const r = await onboard({
    configPath: path,
    ...quiet,
    dryRun: true,
    lookup: github,
  });
  assert.deepEqual(
    r.todo.map((t) => [t.repo, t.found]),
    [["gone/repo", false]],
  );
  assert.deepEqual(writes, []);
});

test("offboard keeps the clone when the board moved to the repo's new name", async () => {
  const { root, path, board } = fixture(NEW);
  const real = clone(root, "code/customers/tektok", NEW);
  writeFileSync(
    path,
    JSON.stringify({ ...config(path), repos: { [OLD]: real } }),
  );
  state.setBoarded([OLD]); // what used to read as "that board was deleted"

  const out = await offboard({
    configPath: path,
    boards: [board],
    lookup: github,
  });

  assert.deepEqual(out, []);
  assert.ok(existsSync(join(real, ".env")));
  assert.deepEqual(config(path).repos, { [OLD]: real });
});

test("offboard still retires a repo that really has no board left", async () => {
  const { root, path, board } = fixture(NEW);
  const real = clone(root, "code/other", "other/thing");
  writeFileSync(
    path,
    JSON.stringify({ ...config(path), repos: { "other/thing": real } }),
  );
  state.setBoarded(["other/thing"]);
  const out = await offboard({
    configPath: path,
    boards: [board],
    lookup: github,
  });
  assert.deepEqual(
    out.map((g) => g.repo),
    ["other/thing"],
  );
  assert.equal(existsSync(real), false);
});

test("offboard deletes nothing while GitHub cannot be asked", async () => {
  const { root, path, board } = fixture(NEW);
  const real = clone(root, "code/customers/tektok", NEW);
  writeFileSync(
    path,
    JSON.stringify({ ...config(path), repos: { [OLD]: real } }),
  );
  state.setBoarded([OLD]);
  await assert.rejects(
    offboard({ configPath: path, boards: [board], lookup: unreachable }),
  );
  assert.ok(existsSync(real));
});

test("matchName prefers the spelling and only then asks GitHub", async () => {
  assert.equal(await matchName(["NEW/app"], NEW, unreachable), "NEW/app");
  assert.equal(await matchName(["x/y", OLD], NEW, github), OLD);
  assert.equal(await matchName(["x/y"], NEW, github), null);
});

test("resolver asks once per name, in any case", async () => {
  let asked = 0;
  const name = resolver(async (r) => (asked++, r));
  await name("A/b");
  await name("a/B");
  assert.equal(asked, 1);
});

test("renameInConfig leaves lists it does not name alone and adds none", () => {
  const path = join(mkdtempSync(join(tmp, "cfg-")), "config.json");
  writeFileSync(
    path,
    JSON.stringify({ repos: { [OLD]: "~/x", "a/b": "~/y" } }),
  );
  renameInConfig(path, OLD, NEW);
  assert.deepEqual(config(path), { repos: { "a/b": "~/y", [NEW]: "~/x" } });
});
