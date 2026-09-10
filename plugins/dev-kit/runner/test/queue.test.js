import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { blockedFile, listPending, numberOf } from "../src/queue.js";

/** A throwaway repo whose task folder holds exactly `names`. */
function repo(names) {
  const path = mkdtempSync(join(tmpdir(), "queue-"));
  for (const n of names) writeFileSync(join(path, n), "x");
  return path;
}

test("reads the leading number, however wide", () => {
  assert.equal(numberOf("165-chromeExt-TODO.md"), "165");
  assert.equal(numberOf("1042-big-TODO.md"), "1042");
  assert.equal(numberOf("README.md"), null);
});

test("a -DONE or -BLOCKED sibling retires that task", () => {
  const path = repo([
    "165-a-TODO.md",
    "165-a-BLOCKED.md",
    "166-b-TODO.md",
    "166-b-DONE.md",
    "167-c-TODO.md",
  ]);
  assert.deepEqual(
    listPending(path, ".").map((p) => p.number),
    ["167"],
  );
});

test("orders by number, not by string, so 1042 comes after 167", () => {
  const path = repo(["1042-b-TODO.md", "167-a-TODO.md"]);
  assert.deepEqual(
    listPending(path, ".").map((p) => p.number),
    ["167", "1042"],
  );
});

test("names the -BLOCKED file a task ended as, not a namesake's", () => {
  const path = repo(["165-a-BLOCKED.md", "165-b-DONE.md", "166-c-DONE.md"]);
  assert.equal(blockedFile(path, ".", "165-a"), "165-a-BLOCKED.md");
  assert.equal(blockedFile(path, ".", "165-b"), null);
  assert.equal(blockedFile(path, ".", "166-c"), null);
});

test("a finished task does not retire a different task sharing its number", () => {
  // ezysmart-web: 019-errors was finished under the old "next free NNN" scheme;
  // the Kanban then wrote 019-task012Fix for GitHub issue #19. Retiring by number
  // alone made the new task invisible the moment it was written.
  const path = repo([
    "019-errors-TODO.md",
    "019-errors-DONE.md",
    "019-task012Fix-TODO.md",
  ]);
  assert.deepEqual(
    listPending(path, ".").map((p) => p.name),
    ["019-task012Fix-TODO.md"],
  );
});
