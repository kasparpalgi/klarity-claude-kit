/**
 * Detect Claude's own usage-limit message in a run's output. There is no API
 * for a headless script to ask "% of session left" ahead of time, so this is
 * reactive: only the CLI's own wording tells us the wall was hit. When it names
 * a real reset moment we honour it exactly; only a message with no time at all
 * falls back to a conservative fixed wait.
 */

const SESSION_HOURS = 5;
const WEEKLY_DAYS = 7;

const WEEKLY = /hit your weekly limit|weekly limit reached/i;
const SESSION =
  /hit your (?:session|5-hour) limit|5-hour limit reached|session limit reached|rate limit hit|usage limit reached|limit reached.*resets?/i;
const RETRY_HOURS = /please try again in (\d+)\s*hours?/i;
// Headless `-p` prints exactly this when the wall is hit: the pipe is followed by
// the reset time as a unix epoch (seconds). This is the only wording that carries
// the real reset moment, so it wins — no conservative fallback guessing needed.
const EPOCH = /usage limit reached\s*\|\s*(\d{10,13})/i;
// Interactive / herdr-pane runs print the human wording instead — a local clock
// time plus an IANA zone, e.g. "resets 5:40pm (Europe/Tallinn)". The zone (a
// Region/City with a slash — never a bare "UTC") lets us turn it into the same
// exact moment the epoch would, so we no longer round a 45-min wait up to 5h.
const RESET_AT =
  /resets?\s+(\d{1,2})(?::(\d{2}))?\s*(am|pm)?\s*\(([A-Za-z]+\/[A-Za-z_/]+)\)/i;

/** Epoch ms for the next moment the wall clock in `tz` reads `h:m` (24h). */
function nextLocalTime(h, m, tz, now = Date.now()) {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: tz,
    hour: "numeric",
    minute: "numeric",
    second: "numeric",
    hour12: false,
  }).formatToParts(new Date(now));
  const at = (t) => Number(parts.find((p) => p.type === t).value);
  const nowMin = (at("hour") % 24) * 60 + at("minute");
  let deltaMin = h * 60 + m - nowMin;
  if (deltaMin <= 0) deltaMin += 1440; // clock already past today → tomorrow
  // Elapsed wall-clock minutes equal elapsed real minutes over a sub-day window,
  // so no timezone-offset maths is needed; land on the :00 of the target minute.
  return now + deltaMin * 60_000 - at("second") * 1000;
}

/** `{ untilMs, scope }` when `output` shows a usage limit was hit, else null. */
export function usageLimitHit(output) {
  const epoch = EPOCH.exec(output);
  if (epoch) {
    const n = Number(epoch[1]);
    return { untilMs: n < 1e12 ? n * 1000 : n, scope: "session" };
  }
  // Weekly first: its "resets Oct 9" date is out of RESET_AT's reach, and a
  // stray zone in it must not be read as a same-day session reset.
  if (WEEKLY.test(output))
    return { untilMs: Date.now() + WEEKLY_DAYS * 86_400_000, scope: "weekly" };
  const at = RESET_AT.exec(output);
  if (at && SESSION.test(output)) {
    let h = Number(at[1]) % 12;
    if (/pm/i.test(at[3] ?? "")) h += 12;
    else if (!at[3]) h = Number(at[1]) % 24; // 24h clock: no am/pm marker
    return {
      untilMs: nextLocalTime(h, Number(at[2] ?? 0), at[4]),
      scope: "session",
    };
  }
  const retry = RETRY_HOURS.exec(output);
  if (retry)
    return {
      untilMs: Date.now() + Number(retry[1]) * 3600_000,
      scope: "session",
    };
  if (SESSION.test(output))
    return { untilMs: Date.now() + SESSION_HOURS * 3600_000, scope: "session" };
  return null;
}
