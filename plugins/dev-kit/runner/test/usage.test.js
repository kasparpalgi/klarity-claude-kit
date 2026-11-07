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
  const hit = usageLimitHit("5-hour limit reached");
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

test("the human 'resets <time> (Zone)' wording gives the exact reset, not 5h", () => {
  // 40 minutes from now, expressed as a wall-clock time in a real IANA zone.
  const tz = "Europe/Tallinn";
  const target = new Date(Date.now() + 40 * 60_000);
  const clock = target.toLocaleTimeString("en-US", {
    timeZone: tz,
    hour: "numeric",
    minute: "2-digit",
    hour12: true,
  }); // e.g. "5:40 PM"
  const hit = usageLimitHit(
    `You've hit your session limit · resets ${clock} (${tz})`,
  );
  assert.equal(hit.scope, "session");
  // Within two minutes of 40 min out — nowhere near the 5h fallback.
  assert.ok(Math.abs(hit.untilMs - target.getTime()) < 120_000);
});

// server 026 on the Mac, Nov 7 2026: the wall came at 23:08:57 Tallinn (EET, UTC+2).
const WALL_026 =
  "You've hit your 5-hour limit · resets 12:10am (Europe/Tallinn)";
const at = (iso) => Date.parse(iso);

test("12:10am is ten past midnight tonight, a minute after the CLI's minute", () => {
  const hit = usageLimitHit(WALL_026, at("2026-11-07T21:08:57Z"));
  assert.equal(hit.scope, "session");
  assert.equal(hit.untilMs, at("2026-11-07T22:11:00Z")); // 00:11 in Tallinn
});

test("a reset minute already reached means look again soon, not tomorrow", () => {
  const now = at("2026-11-07T22:12:00Z"); // 00:12 in Tallinn, wall still up
  const hit = usageLimitHit(WALL_026, now);
  assert.equal(hit.untilMs, now + 15 * 60_000);
});

test("a DST change before the reset does not move it an hour", () => {
  // 03:00 EEST on Oct 25 2026; at 04:00 EEST the clocks go back to 03:00 EET.
  const hit = usageLimitHit(
    "You've hit your session limit · resets 5am (Europe/Tallinn)",
    at("2026-10-25T00:00:00Z"),
  );
  assert.equal(hit.untilMs, at("2026-10-25T03:01:00Z")); // 05:01 EET
});

test("a bare 'UTC' and any other region's zone give the exact reset", () => {
  const now = at("2026-11-07T12:00:00Z");
  const utc = usageLimitHit(
    "You've hit your session limit · resets 3pm (UTC)",
    now,
  );
  assert.equal(utc.untilMs, at("2026-11-07T15:01:00Z"));
  const ny = usageLimitHit(
    "You've hit your session limit · resets 9:30am (America/New_York)",
    now,
  );
  assert.equal(ny.untilMs, at("2026-11-07T14:31:00Z")); // EST, UTC-5
});

test("a zone Intl does not know stays on the fixed fallback", () => {
  const now = at("2026-11-07T12:00:00Z");
  const hit = usageLimitHit(
    "5-hour limit reached - resets 3pm (Mars/Olympus)",
    now,
  );
  assert.equal(hit.untilMs, now + 5 * 3600_000);
});
