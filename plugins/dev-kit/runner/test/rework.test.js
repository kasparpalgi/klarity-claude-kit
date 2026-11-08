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
import { asks, MARK, sweepRework } from "../src/rework.js";

const DIR = "doc/todo";
const at = (min) =>
  new Date(Date.parse("2026-11-08T12:00:00Z") + min * 60_000).toISOString();
const kaspar = { __typename: "User", login: "kaspar" };
const bot = { __typename: "Bot", login: "coderabbitai" };
const said = (author, min, body = "please fix") => ({
  author,
  body,
  createdAt: at(min),
  url: `https://github.com/o/r/pull/9#c${min}`,
});
const thread = (comments, o = {}) => ({
  id: `T${comments.length}`,
  isResolved: false,
  path: "src/a.ts",
  line: 3,
  comments: { nodes: comments },
  ...o,
});
const pr = (o = {}) => ({
  number: 9,
  title: "T",
  url: "https://github.com/o/r/pull/9",
  headRefName: "todo/090-x",
  commits: { nodes: [{ commit: { committedDate: at(0) } }] },
  latestReviews: { nodes: [] },
  reviewThreads: { nodes: [] },
  files: { nodes: [] },
  ...o,
});
const changes = (author, min) => ({
  author,
  state: "CHANGES_REQUESTED",
  submittedAt: at(min),
  body: "Not like this",
  url: "https://github.com/o/r/pull/9#r1",
});

test("a person's request for changes, or their thread after the last push, is asked", () => {
  const ask = asks(
    pr({
      latestReviews: { nodes: [changes(kaspar, -30)] },
      reviewThreads: { nodes: [thread([said(kaspar, 5)])] },
    }),
  );
  assert.equal(ask.reviews.length, 1);
  assert.equal(ask.threads.length, 1);
  assert.equal(ask.round, at(5));
});

test("bots, resolved threads, answered threads and pre-push threads ask nothing", () => {
  const ask = asks(
    pr({
      latestReviews: {
        nodes: [changes(bot, 5), { ...changes(kaspar, 5), state: "APPROVED" }],
      },
      reviewThreads: {
        nodes: [
          thread([said(bot, 5)]),
          thread([said(kaspar, 5)], { isResolved: true }),
          thread([said(kaspar, 5), said(kaspar, 6, `${MARK} Fixed in abc`)]),
          thread([said(kaspar, -5)]), // older than the last push
          thread([said(kaspar, 5), said(bot, 6)]), // bot reply: still kaspar's word
        ],
      },
    }),
  );
  assert.deepEqual(ask.reviews, []);
  assert.equal(ask.threads.length, 1);
  assert.equal(ask.threads[0].last.createdAt, at(5));
});

function setup() {
  const root = mkdtempSync(join(tmpdir(), "rework-"));
  const run = (cwd, ...a) => execFileSync("git", a, { cwd, encoding: "utf8" });
  run(root, "init", "-q", "--bare", "-b", "main", "origin.git");
  run(root, "clone", "-q", "origin.git", "dell");
  const dell = join(root, "dell");
  run(dell, "config", "user.email", "t@t.t");
  run(dell, "config", "user.name", "dell");
  mkdirSync(join(dell, DIR), { recursive: true });
  writeFileSync(join(dell, DIR, "090-x-TODO.md"), "# X\n");
  run(dell, "add", "-A");
  run(dell, "commit", "-qm", "base");
  run(dell, "push", "-q", "origin", "HEAD:main");
  return { dell, run };
}

test("one rework task per review round, on todo/* PRs only", async () => {
  const { dell, run } = setup();
  const review = pr({ latestReviews: { nodes: [changes(kaspar, 5)] } });
  const prs = [review, { ...review, number: 10, headRefName: "feature/mine" }];
  const sweep = (handedTo) =>
    sweepRework({ repoPath: dell, dir: DIR, prs, handedTo });

  assert.deepEqual(await sweep(), ["filed 091-reworkPr9-TODO.md"]);
  const body = readFileSync(join(dell, DIR, "091-reworkPr9-TODO.md"), "utf8");
  assert.match(body, /git switch todo\/090-x/);
  assert.match(body, /kaspar — changes requested: Not like this/);
  assert.match(body, /addPullRequestReviewThreadReply/);
  assert.deepEqual(await sweep(), [], "queued: not filed again");

  // The session ran on the PR's branch; main still reads -TODO until the merge.
  assert.deepEqual(await sweep(() => 9), [], "same round: not filed again");

  review.reviewThreads.nodes.push(thread([said(kaspar, 20, "and this")]));
  assert.deepEqual(await sweep(() => 9), ["filed 092-reworkPr9-TODO.md"]);
  assert.equal(run(dell, "status", "--porcelain"), "");
  assert.equal(readdirSync(join(dell, DIR)).length, 3);
});
