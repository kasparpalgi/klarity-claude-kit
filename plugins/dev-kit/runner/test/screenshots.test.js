import { test, mock } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ignoreLogs } from "../src/repo.js";
import {
  attachScreenshots,
  carryScreenshots,
  screenshotsOf,
} from "../src/screenshots.js";

const STEM = "069-proofOfWork";
const dir = (...names) => {
  const d = mkdtempSync(join(tmpdir(), "shots-"));
  for (const n of names) writeFileSync(join(d, n), "png");
  return d;
};

test("takes this task's PNGs only, at most three", () => {
  const d = dir(
    `${STEM}-4.png`,
    `${STEM}-1.png`,
    `${STEM}-2.png`,
    `${STEM}-3.png`,
    `${STEM}.log`,
    "070-other-1.png",
  );
  assert.deepEqual(screenshotsOf(d, STEM), [
    `${STEM}-1.png`,
    `${STEM}-2.png`,
    `${STEM}-3.png`,
  ]);
  assert.deepEqual(screenshotsOf(join(d, "missing"), STEM), []);
});

test("carries a worktree's screenshots to the main checkout", () => {
  const from = dir(`${STEM}-1.png`, "070-other-1.png");
  const to = dir();
  carryScreenshots(from, to, STEM);
  assert.deepEqual(screenshotsOf(to, STEM), [`${STEM}-1.png`]);
  assert.deepEqual(screenshotsOf(to, "070-other"), []);
});

test("no screenshots → no request at all", async () => {
  const fetch = mock.method(globalThis, "fetch", async () => {
    throw new Error("must not be called");
  });
  const out = await attachScreenshots(
    { appUrl: "https://k.test", endpoint: "https://h.test" },
    { full: dir(`${STEM}.log`), stem: STEM, id: "card" },
  );
  assert.deepEqual(out, []);
  assert.equal(fetch.mock.callCount(), 0);
  fetch.mock.restore();
});

test("uploads only what the card does not show yet", async () => {
  const calls = [];
  const fetch = mock.method(globalThis, "fetch", async (url, init) => {
    calls.push(String(url));
    const body = String(url).startsWith("https://h.test")
      ? { data: { uploads: [{ url: `https://cdn/x/123-${STEM}-1.png` }] } }
      : { success: true };
    return { status: 200, json: async () => body };
  });
  const out = await attachScreenshots(
    { appUrl: "https://k.test", endpoint: "https://h.test", adminSecret: "s" },
    { full: dir(`${STEM}-1.png`, `${STEM}-2.png`), stem: STEM, id: "card" },
  );
  assert.deepEqual(out, ["1 screenshot(s) attached"]);
  assert.deepEqual(calls, [
    "https://h.test",
    "https://k.test/api/runner/upload",
  ]);
  fetch.mock.restore();
});

test("ignores logs and task screenshots, but not assets", async () => {
  const path = mkdtempSync(join(tmpdir(), "ign-"));
  const git = (...a) => execFileSync("git", a, { cwd: path }).toString();
  git("init", "-q");
  git("config", "user.email", "t@t.t");
  git("config", "user.name", "t");
  const todo = join(path, "doc", "todo");
  mkdirSync(join(todo, "assets"), { recursive: true });
  writeFileSync(join(todo, ".gitignore"), "*.log"); // an older rule, no newline
  await ignoreLogs(todo, path);
  assert.equal(
    readFileSync(join(todo, ".gitignore"), "utf8"),
    "*.log\n/[0-9]*-*.png\n",
  );
  writeFileSync(join(todo, `${STEM}-1.png`), "png");
  writeFileSync(join(todo, "assets", "diagram.png"), "png");
  assert.equal(
    git("status", "--porcelain", "-uall").trim(),
    "?? doc/todo/assets/diagram.png",
  );
  await ignoreLogs(todo, path); // already there: no second commit
  assert.equal(git("rev-list", "--count", "HEAD").trim(), "1");
});
