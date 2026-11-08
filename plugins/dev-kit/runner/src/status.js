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
import { BOARD, gql } from "./kanban.js";

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
  { machine, startMs, endMs, tier, attempt, costUsd, note },
) {
  const open = kind === "running" || kind === "needs";
  const span = open
    ? `since ${hhmm(startMs)}`
    : `${hhmm(startMs)}–${hhmm(endMs)}`;
  return [
    `${KINDS[kind]} on ${machine} ${span}`,
    tier,
    `attempt ${attempt}`,
    costUsd != null ? `$${costUsd.toFixed(2)}` : null,
    note,
  ]
    .filter(Boolean)
    .join(" · ");
}

/** `usage: … → $2.3312` (recordUsage's log line) → 2.3312, else null. */
export const costIn = (line) => {
  const m = /→ \$(\d+(?:\.\d+)?)/.exec(line ?? "");
  return m ? Number(m[1]) : null;
};

const MINE = `query M($id: uuid!, $user: uuid!) {
  comments(where: {todo_id: {_eq: $id}, user_id: {_eq: $user}}, order_by: {created_at: desc}) {
    id content
  }
}`;
const POST = `mutation P($id: uuid!, $user: uuid!, $body: String!) {
  insert_comments_one(object: {todo_id: $id, user_id: $user, content: $body}) { id }
}`;
const EDIT = `mutation E($id: uuid!, $body: String!) {
  update_comments(where: {id: {_eq: $id}}, _set: {content: $body}) { affected_rows }
}`;

/**
 * Post the run's status comment — or take over the one an unfinished earlier attempt
 * left — and return `say(kind, extra)` to edit it. Without a Kanban or a card, `say`
 * does nothing.
 */
export async function openStatus(
  kanban,
  { repoName, todoId, machine, tier, attempt, log },
) {
  const run = {
    machine: machine ?? hostname(),
    startMs: Date.now(),
    tier,
    attempt,
  };
  let commentId = null;
  const write = async (body) => {
    if (!kanban?.endpoint || !kanban?.adminSecret || !todoId) return;
    try {
      if (commentId)
        return void (await gql(kanban, EDIT, { id: commentId, body }));
      const { boards } = await gql(kanban, BOARD, { repo: `%${repoName}%` });
      const user = boards?.[0]?.user_id;
      if (!user) return;
      const { comments } = await gql(kanban, MINE, { id: todoId, user });
      const last = comments.find((c) => STATUS.test(c.content ?? ""));
      if (last && !last.content.startsWith(KINDS.finished)) {
        commentId = last.id;
        await gql(kanban, EDIT, { id: commentId, body });
      } else
        commentId = (await gql(kanban, POST, { id: todoId, user, body }))
          .insert_comments_one.id;
    } catch (err) {
      log?.(`  status comment: ${err.message}`);
    }
  };
  const say = (kind, extra = {}) =>
    write(statusLine(kind, { ...run, endMs: Date.now(), ...extra }));
  await say("running");
  return say;
}
