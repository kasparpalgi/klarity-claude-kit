import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileUnstick, fixerOf } from "../src/unstick.js";
import { fakeApi, KANBAN } from "./fakeApi.js";

const DIR = "doc/todo";

const CARD = "453da375-fd02-4e60-b754-53761c3754b2";

/** A clone of a bare origin with one stuck task in its folder, addressed by `header`. */
function setup(header = "> Machine: dell") {
  const root = mkdtempSync(join(tmpdir(), "unstick-"));
  const run = (cwd, ...a) => execFileSync("git", a, { cwd, encoding: "utf8" });
  run(root, "init", "-q", "--bare", "-b", "main", "origin.git");
  run(root, "clone", "-q", "origin.git", "dell");
  const repo = join(root, "dell");
  run(repo, "config", "user.email", "t@t.t");
  run(repo, "config", "user.name", "t");
  mkdirSync(join(repo, DIR), { recursive: true });
  writeFileSync(
    join(repo, DIR, "231-runnerApi-TODO.md"),
    `> Run with: Opus 5.5 / medium\n${header}\n\n# Runner API\n\n_From Kanban card \`${CARD}\`, moved to the agent list._\n`,
  );
  run(repo, "add", "-A");
  run(repo, "commit", "-qm", "base");
  run(repo, "push", "-q", "origin", "HEAD:main");
  return { repo, run };
}

const auto = {
  number: "231",
  stem: "231-runnerApi",
  name: "231-runnerApi-TODO.md",
  machine: null,
};
const stuck = { ...auto, machine: "dell" };

test("a stuck task gets one pushed fixer on this machine, at its own tier", async () => {
  const { repo, run } = setup();
  const args = { repoPath: repo, dir: DIR, task: stuck, machine: "dell" };
  assert.equal(await fileUnstick(args), "filed 232-unstick231-TODO.md");
  const body = readFileSync(join(repo, DIR, "232-unstick231-TODO.md"), "utf8");
  assert.match(body, /^> Run with: Opus 5\.5 \/ medium\n> Machine: dell \(the stuck run's log is here\)\n/);
  assert.ok(body.includes(join(repo, DIR, "231-runnerApi.log")));
  assert.match(
    run(repo, "log", "--oneline", "origin/main", "-1"),
    /unstick231/,
  );
  assert.equal(await fileUnstick(args), null, "one fixer per task");
  assert.equal(readdirSync(join(repo, DIR)).length, 2);
});

test("a stuck fixer files no fixer of its own", async () => {
  const { repo } = setup();
  const task = {
    number: "232",
    stem: "232-unstick231",
    name: "232-unstick231-TODO.md",
  };
  assert.equal(await fileUnstick({ repoPath: repo, dir: DIR, task }), null);
});

test("a stuck Auto task gets an Auto fixer, then gives its card back (#17)", async () => {
  const { repo } = setup("");
  const seen = fakeApi({ releaseCard: () => ({ released: true }) });
  const args = { kanban: KANBAN, repoPath: repo, dir: DIR, task: auto, machine: "mac" };
  assert.equal(
    await fileUnstick(args),
    "filed 232-unstick231-TODO.md, its card is back on Auto",
  );
  const body = readFileSync(join(repo, DIR, "232-unstick231-TODO.md"), "utf8");
  assert.doesNotMatch(body, /^> Machine:/m, "any free runner may take it");
  assert.match(body, /transcript on mac `/);
  assert.deepEqual(seen, [["releaseCard", { id: CARD, machine: "mac" }]]);
  assert.equal(
    await fileUnstick(args),
    "its card is back on Auto",
    "parked on a second machine: no second fixer, but it lets go too",
  );
});

test("an addressed task keeps its card, and a failed release keeps the fixer", async () => {
  const seen = fakeApi({});
  const { repo } = setup();
  const args = { kanban: KANBAN, repoPath: repo, dir: DIR, task: stuck, machine: "dell" };
  assert.equal(await fileUnstick(args), "filed 232-unstick231-TODO.md");
  assert.deepEqual(seen, []);
  const again = setup("");
  assert.equal(
    await fileUnstick({ ...args, repoPath: again.repo, task: auto }),
    "filed 232-unstick231-TODO.md, its card stays here: releaseCard: Unknown op: releaseCard",
  );
});

test("a task waits while its fixer is queued", () => {
  const fixer = { name: "232-unstick231-TODO.md" };
  assert.equal(fixerOf([auto, fixer], auto), fixer);
  assert.equal(fixerOf([auto, { name: "233-unstick23-TODO.md" }], auto), undefined);
});
