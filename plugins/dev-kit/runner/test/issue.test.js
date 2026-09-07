import { test } from "node:test";
import assert from "node:assert/strict";
import { issueOf } from "../src/issue.js";

test("reads the issue the task file names", () => {
  assert.equal(
    issueOf("# Fix errors\n\n_GitHub issue #2 — end the commit subject with `(#2)`._"),
    "2",
  );
});

test("never guesses an issue the file does not name", () => {
  // 033-issueNumbers-DONE.md in a repo whose numbers are not issue numbers must not
  // close that repo's unrelated issue #33.
  assert.equal(issueOf("# 033 task\n\nno issue line here"), null);
  assert.equal(issueOf("see GitHub issue #7 in the prose"), null);
});
