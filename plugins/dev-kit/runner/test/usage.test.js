import { test } from "node:test";
import assert from "node:assert/strict";
import { usageLimitHit } from "../src/usage.js";

test("no limit message returns null", () => {
  assert.equal(usageLimitHit("all good, task done"), null);
});

test("an explicit retry-in-N-hours wins over the fixed fallback", () => {
  const hit = usageLimitHit("Please try again in 2 hours.");
  assert.equal(hit.scope, "session");
  assert.ok(hit.untilMs - Date.now() <= 2 * 3600_000 + 1000);
  assert.ok(hit.untilMs - Date.now() > 1.9 * 3600_000);
});

test("a weekly-limit message gets the 7-day fallback", () => {
  const hit = usageLimitHit(
    "You've hit your weekly limit · resets Oct 9, 10am",
  );
  assert.equal(hit.scope, "weekly");
  assert.ok(hit.untilMs - Date.now() > 6 * 86_400_000);
});

test("a session-limit message gets the 5-hour fallback", () => {
  const hit = usageLimitHit("5-hour limit reached - resets 3pm (UTC)");
  assert.equal(hit.scope, "session");
  assert.ok(hit.untilMs - Date.now() > 4 * 3600_000);
});

test("the headless epoch wall message gives the exact reset time", () => {
  const reset = Math.floor(Date.now() / 1000) + 2 * 3600; // 2h out, in seconds
  const hit = usageLimitHit(`Claude AI usage limit reached|${reset}`);
  assert.equal(hit.scope, "session");
  assert.equal(hit.untilMs, reset * 1000);
});

test("a bare 'usage limit reached' is caught even without a reset time", () => {
  const hit = usageLimitHit("Claude AI usage limit reached");
  assert.equal(hit.scope, "session");
  assert.ok(hit.untilMs - Date.now() > 4 * 3600_000);
});
