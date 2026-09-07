/**
 * Detect Claude's own usage-limit message in a run's output. There is no API
 * for a headless script to ask "% of session left" ahead of time, so this is
 * reactive: only the CLI's own wording tells us the wall was hit. Exact reset
 * times come with a timezone and can land on either side of midnight, so we
 * don't parse them — a conservative fixed wait is simpler and never early.
 */

const SESSION_HOURS = 5;
const WEEKLY_DAYS = 7;

const WEEKLY = /hit your weekly limit|weekly limit reached/i;
const SESSION =
  /hit your (?:session|5-hour) limit|5-hour limit reached|session limit reached|rate limit hit|limit reached.*resets?/i;
const RETRY_HOURS = /please try again in (\d+)\s*hours?/i;

/** `{ untilMs, scope }` when `output` shows a usage limit was hit, else null. */
export function usageLimitHit(output) {
  const retry = RETRY_HOURS.exec(output);
  if (retry)
    return {
      untilMs: Date.now() + Number(retry[1]) * 3600_000,
      scope: "session",
    };
  if (WEEKLY.test(output))
    return { untilMs: Date.now() + WEEKLY_DAYS * 86_400_000, scope: "weekly" };
  if (SESSION.test(output))
    return { untilMs: Date.now() + SESSION_HOURS * 3600_000, scope: "session" };
  return null;
}
