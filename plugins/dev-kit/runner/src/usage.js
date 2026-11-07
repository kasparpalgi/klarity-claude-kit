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
// time plus the zone it is in, e.g. "resets 12:10am (Europe/Tallinn)". Any zone
// Intl knows counts, a bare "UTC" too; an unknown one falls back to the fixed wait.
const RESET_AT =
  /resets?\s+(\d{1,2})(?::(\d{2}))?\s*(am|pm)?\s*\(([A-Za-z_]+(?:\/[A-Za-z0-9_+-]+)*)\)/i;
// The CLI shows only the minute and the reset may fall anywhere in it, so wait
// until just after it. A reset already behind us is looked at again soon.
const SLACK_MS = 60_000;
const RECHECK_MS = 15 * 60_000;
const HOUR = 3600_000;
const DAY = 24 * HOUR;

/** What the wall clock in `tz` reads at `ms`, as the UTC epoch of those digits. */
function wallMs(ms, tz) {
  const p = Object.fromEntries(
    new Intl.DateTimeFormat("en-US", {
      timeZone: tz,
      hourCycle: "h23",
      year: "numeric",
      month: "numeric",
      day: "numeric",
      hour: "numeric",
      minute: "numeric",
    })
      .formatToParts(new Date(ms))
      .map((x) => [x.type, Number(x.value)]),
  );
  return Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute);
}

/**
 * The real moment `tz`'s wall clock reads `h:m`, on whichever day puts it nearest
 * `now`. A session resets at most 5h ahead, so one more than 12h ahead had already
 * passed — it means "now", never "same time tomorrow". The offset is read at the
 * reset itself, not at `now`, so a DST change in between cannot shift it an hour.
 */
function resetMs(h, m, tz, now) {
  const today = wallMs(now, tz);
  let wall = today - (today % DAY) + h * HOUR + m * 60_000;
  if (wall - today > 12 * HOUR) wall -= DAY;
  else if (today - wall > 12 * HOUR) wall += DAY;
  const offset = (ms) => wallMs(ms, tz) - (ms - (ms % 60_000));
  const guess = wall - offset(now);
  return wall - offset(guess);
}

const knownZone = (tz) => {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: tz });
    return true;
  } catch {
    return false;
  }
};

/** `{ untilMs, scope }` when `output` shows a usage limit was hit, else null. */
export function usageLimitHit(output, now = Date.now()) {
  const epoch = EPOCH.exec(output);
  if (epoch) {
    const n = Number(epoch[1]);
    return { untilMs: n < 1e12 ? n * 1000 : n, scope: "session" };
  }
  // Weekly first: its "resets Oct 9" date is out of RESET_AT's reach, and a
  // stray zone in it must not be read as a same-day session reset.
  if (WEEKLY.test(output))
    return { untilMs: now + WEEKLY_DAYS * DAY, scope: "weekly" };
  const at = RESET_AT.exec(output);
  if (at && SESSION.test(output) && knownZone(at[4])) {
    let h = Number(at[1]) % 12; // 12am is 0:xx, 12pm is 12:xx
    if (/pm/i.test(at[3] ?? "")) h += 12;
    else if (!at[3]) h = Number(at[1]) % 24; // 24h clock: no am/pm marker
    const reset = resetMs(h, Number(at[2] ?? 0), at[4], now) + SLACK_MS;
    return {
      untilMs: reset > now ? reset : now + RECHECK_MS,
      scope: "session",
    };
  }
  const retry = RETRY_HOURS.exec(output);
  if (retry)
    return { untilMs: now + Number(retry[1]) * HOUR, scope: "session" };
  if (SESSION.test(output))
    return { untilMs: now + SESSION_HOURS * HOUR, scope: "session" };
  return null;
}
