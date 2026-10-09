import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  finishMerged,
  greenSince,
  nextNumber,
  prOf,
  sweepPrs,
  STUCK_MS,
} from "../src/pr.js";
import { afterOf, listPending } from "../src/queue.js";

const DIR = "doc/todo";
const task = (stem, issue = null) => ({ stem, issue, name: `${stem}-TODO.md` });

test("a PR carries the task on its branch, the one it finishes, and the issue it closes", () => {
  const prs = [
    { number: 90, headRefName: "todo/078-mentor", files: [] },
    {
      number: 91,
      headRefName: "claude/x",
      files: [{ path: `${DIR}/187-gateFailurePr84-DONE.md` }],
    },
    { number: 92, headRefName: "claude/y", body: "Closes #79", files: [] },
  ];
  assert.equal(prOf(task("078-mentor"), prs, DIR)?.number, 90);
  assert.equal(prOf(task("187-gateFailurePr84"), prs, DIR)?.number, 91);
  assert.equal(prOf(task("079-other", "79"), prs, DIR)?.number, 92);
  // A number alone proves nothing: CI's failure files take the next free one.
  assert.equal(prOf(task("079-gateFailure20261009"), prs, DIR), undefined);
  // The session ended on another PR's branch (a review, a gate fix).
  assert.equal(prOf(task("183-codeReview"), prs, DIR, 91)?.number, 91);
});

test("a -TODO file a PR adds is a new task, not the one it carries", () => {
  const pr = {
    number: 93,
    headRefName: "claude/z",
    files: [{ path: `${DIR}/186-leftovers-TODO.md` }],
  };
  assert.equal(prOf(task("186-leftovers"), [pr], DIR), undefined);
});

test("listPending skips what is in flight; > After: names what must land first", () => {
  const repo = mkdtempSync(join(tmpdir(), "pending-"));
  mkdirSync(join(repo, DIR), { recursive: true });
  writeFileSync(join(repo, DIR, "078-a-TODO.md"), "# A\n");
  writeFileSync(
    join(repo, DIR, "079-b-TODO.md"),
    "> Run with: Opus 5 / high\n> After: #78, #80\n\n# B\n",
  );
  const names = (skip) => listPending(repo, DIR, skip).map((t) => t.stem);
  assert.deepEqual(names(), ["078-a", "079-b"]);
  assert.deepEqual(
    names((t) => t.stem === "078-a"),
    ["079-b"],
  );
  assert.deepEqual(listPending(repo, DIR)[1].after, ["78", "80"]);
  assert.deepEqual(afterOf("Do this after: #12 is merged"), []);
});

test("green means every check's latest run passed; an older cancelled run does not count", () => {
  const at = (m) => new Date(Date.UTC(2026, 9, 9, 9, m)).toISOString();
  const run = (name, conclusion, m) => ({
    name,
    status: "COMPLETED",
    conclusion,
    completedAt: at(m),
  });
  assert.equal(
    greenSince({
      statusCheckRollup: [
        run("gate", "CANCELLED", 1),
        run("gate", "SUCCESS", 9),
        run("deploy", "SKIPPED", 9),
      ],
    }),
    Date.parse(at(9)),
  );
  assert.equal(
    greenSince({ statusCheckRollup: [run("gate", "FAILURE", 9)] }),
    null,
  );
  assert.equal(
    greenSince({
      statusCheckRollup: [{ name: "gate", status: "IN_PROGRESS" }],
    }),
    null,
  );
  assert.equal(greenSince({ statusCheckRollup: [] }), null);
});

test("nextNumber clears every number in use", () => {
  assert.equal(
    nextNumber(["183-a-DONE.md", "186-b-TODO.md", ".gitignore"]),
    "187",
  );
});

/** A bare origin and two runner clones holding one task folder. */
function setup() {
  const root = mkdtempSync(join(tmpdir(), "pr-"));
  const run = (cwd, ...a) => execFileSync("git", a, { cwd, encoding: "utf8" });
  run(root, "init", "-q", "--bare", "-b", "main", "origin.git");
  run(root, "clone", "-q", "origin.git", "seed");
  const seed = join(root, "seed");
  mkdirSync(join(seed, DIR), { recursive: true });
  writeFileSync(
    join(seed, DIR, "078-mentor-TODO.md"),
    "# Mentor\n\n_GitHub issue #78 — end the commit subject with `(#78)`._\n",
  );
  writeFileSync(
    join(seed, DIR, "183-codeReviewTask83-DONE.md"),
    "# Review\n\nReview PR #84.\n",
  );
  run(seed, "add", "-A");
  run(
    seed,
    "-c",
    "user.email=t@t.t",
    "-c",
    "user.name=t",
    "commit",
    "-qm",
    "base",
  );
  run(seed, "push", "-q", "origin", "HEAD:main");
  const clone = (name) => {
    run(root, "clone", "-q", "origin.git", name);
    const path = join(root, name);
    run(path, "config", "user.email", "t@t.t");
    run(path, "config", "user.name", name);
    return path;
  };
  return { dell: clone("dell"), karel: clone("karel"), run };
}

const NOW = Date.parse("2026-10-09T12:00:00Z");
const pr = (o) => ({
  title: "T",
  url: `https://github.com/o/r/pull/${o.number}`,
  headRefName: `todo/${o.number}-x`,
  labels: [],
  createdAt: new Date(NOW - 60 * 60_000).toISOString(),
  statusCheckRollup: [],
  ...o,
});
const green = [
  {
    name: "gate",
    status: "COMPLETED",
    conclusion: "SUCCESS",
    completedAt: new Date(NOW - STUCK_MS - 60_000).toISOString(),
  },
];

test("the sweep files a review for a draft and a task for a stuck PR — once, however many runners sweep", async () => {
  const { dell, karel } = setup();
  const open = [
    pr({ number: 84, isDraft: true }), // already has its review (183)
    pr({ number: 85, isDraft: true }),
    pr({
      number: 86,
      isDraft: true,
      createdAt: new Date(NOW - 60_000).toISOString(),
    }), // still in grace
    pr({ number: 87, isDraft: false, statusCheckRollup: green }),
    pr({
      number: 88,
      isDraft: false,
      statusCheckRollup: green,
      labels: [{ name: "hold" }],
    }),
    pr({
      number: 89,
      isDraft: false,
      statusCheckRollup: green,
      headRefName: "feature/mine",
    }),
  ];
  const sweep = (repoPath) =>
    sweepPrs({ repoPath, dir: DIR, base: "main", open, now: NOW });

  const lines = [...(await sweep(dell)), ...(await sweep(karel))];

  assert.deepEqual(lines.slice(0, 2), [
    "filed 184-codeReviewPr85-TODO.md",
    "filed 185-mergeStuckPr87-TODO.md",
  ]);
  assert.match(lines[2], /another runner filed it first/);
  execFileSync("git", ["pull", "-q", "--ff-only"], { cwd: karel });
  const files = readdirSync(join(karel, DIR)).filter((n) => /Pr\d+/.test(n));
  assert.deepEqual(files.sort(), [
    "184-codeReviewPr85-TODO.md",
    "185-mergeStuckPr87-TODO.md",
  ]);
  assert.match(
    readFileSync(join(karel, DIR, "184-codeReviewPr85-TODO.md"), "utf8"),
    /gh pr ready 85/,
  );
  assert.deepEqual(await sweep(karel), [], "nothing new to file");
});

test("a merged PR's task still -TODO on main is renamed -DONE there", async () => {
  const { dell, run } = setup();
  const merged = [
    { number: 90, headRefName: "claude/abc", body: "Closes #78", files: [] },
  ];
  const lines = await finishMerged({
    repoPath: dell,
    dir: DIR,
    pending: listPending(dell, DIR),
    merged,
    handedTo: () => null,
  });
  assert.deepEqual(lines, ["078-mentor-DONE.md — #90 merged"]);
  assert.ok(existsSync(join(dell, DIR, "078-mentor-DONE.md")));
  assert.match(
    readFileSync(join(dell, DIR, "078-mentor-DONE.md"), "utf8"),
    /pull request #90, which has merged/,
  );
  assert.equal(run(dell, "status", "--porcelain"), "");
  assert.equal(
    run(dell, "rev-parse", "HEAD"),
    run(dell, "rev-parse", "origin/main"),
  );
});
