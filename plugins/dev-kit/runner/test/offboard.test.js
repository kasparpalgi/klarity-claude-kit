import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const tmp = mkdtempSync(join(tmpdir(), "offboard-"));
process.env.KANBAN_RUNNER_STATE = join(tmp, "state.json");
process.env.KANBAN_RUNNER_ARCHIVE = join(tmp, "archived");
const { gone, offboard, whyKeep } = await import("../src/offboard.js");
const { restoreSecrets } = await import("../src/secrets.js");
const state = await import("../src/state.js");

const board = (full_name, archived_at = null) => ({
  github: JSON.stringify({ full_name }),
  archived_at,
});
const git = (args, cwd) =>
  execFileSync("git", args, { cwd, stdio: "pipe" }).toString();

/** A clone level with its origin, with an ignored `.env`. */
function clone(name) {
  const bare = join(tmp, `${name}.git`);
  const dir = join(tmp, name);
  git(["init", "-q", "--bare", "-b", "main", bare], tmp);
  git(["clone", "-q", bare, dir], tmp);
  writeFileSync(join(dir, ".gitignore"), ".env\n");
  writeFileSync(join(dir, ".env"), "KEY=1\n");
  git(["add", "."], dir);
  git(
    ["-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qm", "init"],
    dir,
  );
  git(["push", "-q", "origin", "main"], dir);
  return dir;
}

test("gone(): archived and deleted boards go, live and hand-added repos stay", () => {
  const repos = { "a/live": "", "a/Arch": "", "a/deleted": "", "a/byhand": "" };
  const boards = [board("a/live"), board("a/arch", "2026-10-26")];
  assert.deepEqual(gone(repos, boards, ["a/live", "a/deleted"]), [
    "a/Arch",
    "a/deleted",
  ]);
});

test("gone(): an archived board does not win over a live board on the same repo", () => {
  const boards = [board("a/x"), board("a/x", "2026-10-13")];
  assert.deepEqual(gone({ "a/x": "" }, boards), []);
});

test("gone(): no live board at all is a broken read, not an archive of everything", () => {
  assert.deepEqual(
    gone({ "a/x": "" }, [board("a/x", "2026-10-13")], ["a/x"]),
    [],
  );
});

test("whyKeep(): only work that exists nowhere else keeps a clone", async () => {
  const dir = clone("keep");
  assert.equal(await whyKeep(dir), null);
  writeFileSync(join(dir, "._.env"), "mac junk");
  assert.equal(await whyKeep(dir), null);
  writeFileSync(join(dir, "draft.md"), "x");
  assert.match(await whyKeep(dir), /uncommitted changes — draft\.md/);
  git(["add", "."], dir);
  git(
    ["-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qm", "wip"],
    dir,
  );
  assert.match(await whyKeep(dir), /1 commit\(s\) not pushed/);
});

test("offboard(): deletes the clone, keeps its secrets for a restore, drops the entries", async () => {
  const dir = clone("kusp");
  const configPath = join(tmp, "config.json");
  writeFileSync(
    configPath,
    JSON.stringify({
      repos: {
        "a/live": tmp,
        "a/kusp": dir,
        "a/gone-by-hand": join(tmp, "nope"),
      },
    }),
  );
  state.setBlocked("a/gone-by-hand", "missing");
  const boards = [
    board("a/live"),
    board("a/kusp", "2026-10-26"),
    board("a/gone-by-hand", "2026-10-26"),
  ];

  const dry = await offboard({ configPath, boards, dryRun: true, lookup: async () => null });
  assert.equal(dry.length, 2);
  assert.ok(existsSync(dir), "a dry run deletes nothing");

  const out = await offboard({ configPath, boards, lookup: async () => null });
  assert.deepEqual(
    out.map((o) => [o.repo, o.kept]),
    [
      ["a/kusp", null],
      ["a/gone-by-hand", null],
    ],
  );
  assert.ok(!existsSync(dir));
  assert.deepEqual(
    Object.keys(JSON.parse(readFileSync(configPath, "utf8")).repos),
    ["a/live"],
  );
  assert.equal(state.snapshot().blocked["a/gone-by-hand"], undefined);
  assert.deepEqual(state.boarded(), ["a/live"]);

  // Restored from the archive: onboarding clones it fresh and the `.env` comes back.
  const fresh = join(tmp, "kusp-again");
  mkdirSync(fresh);
  assert.equal(restoreSecrets("a/kusp", fresh), true);
  assert.equal(readFileSync(join(fresh, ".env"), "utf8"), "KEY=1\n");
  assert.equal(
    restoreSecrets("a/kusp", fresh),
    false,
    "restored once, then forgotten",
  );
});

test("offboard(): a clone with unpushed work is unwatched but left on disk", async () => {
  const dir = clone("busy");
  writeFileSync(join(dir, "notes.md"), "x");
  const configPath = join(tmp, "config2.json");
  writeFileSync(configPath, JSON.stringify({ repos: { "a/busy": dir } }));
  const out = await offboard({
    configPath,
    boards: [board("a/live"), board("a/busy", "2026-11-01")],
    lookup: async () => null,
  });
  assert.match(out[0].kept, /uncommitted/);
  assert.ok(existsSync(join(dir, "notes.md")));
  assert.deepEqual(JSON.parse(readFileSync(configPath, "utf8")).repos, {});
});
