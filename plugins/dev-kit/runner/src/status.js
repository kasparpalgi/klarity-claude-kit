/**
 * One live status comment per run on the card (svelte-hasura-boilerplate#68). The
 * card used to say nothing until the Results landed; you had to open herdr to know a
 * task was running at all. Posted when the run starts, then edited in place — by id,
 * never re-posted — on what the runner already knows: the usage wall, ⏸ needs you,
 * a failed or unfinished run, and the finish with its cost. The Results comment stays
 * separate. A retry edits the comment the last attempt left; a finished one is kept,
 * so a card sent back for rework gets a fresh line.
 *
 * Bookkeeping only: every failure here is a log line, never a failed task.
 */

import { hostname } from "node:os";
import { boardOf, hasKanban, runnerApi } from "./kanban.js";

/** The prefixes the Kanban's `cardThread.ts` drops from a re-queued task file. */
export const STATUS =
  /^(▶ Running|⏳ Waiting|⏸ Needs you|✘ Failed|⚠ Did not finish|■ Finished) on /;

const KINDS = {
  running: "▶ Running",
  waiting: "⏳ Waiting",
  needs: "⏸ Needs you",
  failed: "✘ Failed",
  unfinished: "⚠ Did not finish",
  finished: "■ Finished",
};

const hhmm = (ms) =>
  new Date(ms).toLocaleTimeString("en-GB", {
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  });

/** `▶ Running on dell since 14:02 · Opus 5.5 / xhigh · attempt 1`, and its siblings. */
export function statusLine(
  kind,
  { machine, startMs, endMs, tier, attempt, costUsd, note, url },
) {
  const open = ["running", "waiting", "needs"].includes(kind);
  const span = open
    ? `since ${hhmm(startMs)}`
    : `${hhmm(startMs)}–${hhmm(endMs)}`;
  return [
    `${KINDS[kind]} on ${machine} ${span}`,
    tier,
    attempt ? `attempt ${attempt}` : null,
    costUsd != null ? `$${costUsd.toFixed(2)}` : null,
    note,
    url,
  ]
    .filter(Boolean)
    .join(" · ");
}

/** `usage: … → $2.3312` (recordUsage's log line) → 2.3312, else null. */
export const costIn = (line) => {
  const m = /→ \$(\d+(?:\.\d+)?)/.exec(line ?? "");
  return m ? Number(m[1]) : null;
};

/**
 * Post the run's status comment — or take over the one an unfinished earlier attempt
 * left — and return `say(kind, extra)` to edit it. Without a Kanban or a card, `say`
 * does nothing.
 */
export async function openStatus(
  kanban,
  {
    repoName,
    todoId,
    machine,
    tier,
    attempt,
    startMs,
    url,
    log,
    first = "running",
    note,
  },
) {
  // A cloud run (#86) is reopened ticks later: it passes its own start and link.
  const run = {
    machine: machine ?? hostname(),
    startMs: startMs ?? Date.now(),
    tier,
    attempt,
    url,
  };
  let commentId = null;
  const write = async (body) => {
    if (!hasKanban(kanban) || !todoId) return;
    try {
      if (commentId)
        return void (await runnerApi(kanban, "updateComment", {
          id: commentId,
          content: body,
        }));
      const user = (await boardOf(kanban, repoName))?.user_id;
      if (!user) return;
      const comments = await runnerApi(kanban, "comments", {
        todoId,
        userId: user,
      });
      const last = comments.find((c) => STATUS.test(c.content ?? ""));
      if (last && !last.content.startsWith(KINDS.finished)) {
        commentId = last.id;
        await runnerApi(kanban, "updateComment", {
          id: commentId,
          content: body,
        });
      } else
        commentId = (
          await runnerApi(kanban, "createComment", {
            todoId,
            userId: user,
            content: body,
          })
        ).id;
    } catch (err) {
      log?.(`  status comment: ${err.message}`);
    }
  };
  let last = ["running", {}];
  const say = (kind, extra = {}) => {
    last = [kind, extra];
    // The Remote Control link (#85) stays on every later line, finish included.
    if (extra.url) run.url = extra.url;
    return write(statusLine(kind, { ...run, endMs: Date.now(), ...extra }));
  };
  // A link found mid-run (sessionLink.js) joins the line as it stands, whatever its kind.
  say.link = (url) => {
    if (run.url) return;
    run.url = url;
    return say(...last);
  };
  await say(first, { note });
  return say;
}
