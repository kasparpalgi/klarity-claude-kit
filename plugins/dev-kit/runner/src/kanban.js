/**
 * Close the Kanban loop from the runner.
 *
 * Task 016 gave this job to a GitHub push webhook. No webhook was ever registered
 * on the repo (`gh api repos/<r>/hooks` → `[]`) and GITHUB_WEBHOOK_SECRET was never
 * configured, so a finished task never moved its card, never reported what it did,
 * and never filed its follow-ups. The runner knows all three the moment a task ends
 * and needs no deploy, so it says so directly. Where that webhook does run, it leaves
 * a card carrying the runner's status line (status.js) to this file: two closers meant
 * a "✅ Task complete" next to the Results (svelte-hasura-boilerplate#80).
 */

import { readdirSync, readFileSync } from "node:fs";
import { basename, join } from "node:path";
import { reportToIssue } from "./issue.js";
import { attachScreenshots } from "./screenshots.js";
import { stemOf } from "./queue.js";

// The exact marker buildTaskFile() writes, anchored to the start of its own line:
// a follow-up file quotes its parent as "(from Kanban card `…`)" and must not match.
const CARD_ID = /^_From Kanban card `([0-9a-f-]{36})`/m;

/** The card a task file was written for, or null for a hand-written file. */
export const cardIdOf = (text) => CARD_ID.exec(text)?.[1] ?? null;

/**
 * What the agent wrote about its own run. `## Results` when it followed the skill;
 * otherwise everything past the requirement block, because agents do improvise the
 * headings (163 filed Investigation / Plan / Log / Status and no Results at all).
 */
export function resultsOf(text) {
  const results = /^##\s+Results\b.*$/im.exec(text);
  if (results) return text.slice(results.index).trim();
  const headings = [...text.matchAll(/^##\s+(.+)$/gm)];
  const after = headings.find(
    (h) => !/^original requirement$/i.test(h[1].trim()),
  );
  return after && after !== headings[0] ? text.slice(after.index).trim() : null;
}

/** `# Heading` from a task file, else the file's slug. */
export function titleOf(text, filename) {
  const m = /^#\s+(.+)$/m.exec(text);
  return m ? m[1].trim() : basename(filename, ".md");
}

/** True when the runner may talk to the Kanban: it needs the runner API token. */
export const hasKanban = (kanban) => !!kanban?.apiToken;

/**
 * Call one op of the Kanban's runner API: `POST <appUrl>/api/runner/<op>` with the
 * bearer token, answering `{ data }` or `{ error }` (todzz #231). `appUrl` must be the
 * canonical host (`https://www.todzz.eu`): fetch drops `Authorization` on a
 * cross-origin redirect, and `todzz.eu` redirects.
 */
export async function runnerApi(kanban, op, input = {}) {
  const res = await fetch(`${kanban.appUrl}/api/runner/${op}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${kanban.apiToken}`,
    },
    body: JSON.stringify(input),
    signal: AbortSignal.timeout(15000),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok || body.error)
    throw new Error(`${op}: ${body.error ?? `HTTP ${res.status}`}`);
  return body.data;
}

/** The board connected to a repo, with its lists; null when none is. */
export const boardOf = (kanban, repoName) =>
  runnerApi(kanban, "board", { repo: repoName });

/** Every card filed for a path, oldest first: the first one in is the lock
 * (followup.js, claim.js) and a racing runner drops its own. */
export const cardsAt = (kanban, ...paths) =>
  runnerApi(kanban, "cards", { paths });

/** The `-DONE.md` — or `-BLOCKED.md` — this task ended as. Keyed by stem, because a
 * bare NNN can belong to two tasks and this file decides which card gets the Results. */
export function doneFile(dir, stem) {
  return readdirSync(dir).find(
    (n) => /-(DONE|BLOCKED)\.md$/i.test(n) && stemOf(n) === stem,
  );
}

/**
 * Move the card to Review with the agent's own Results as a comment, then report to the
 * issue. Follow-ups the run split out are filed by the reconcile sweep (followup.js).
 * Returns log lines.
 */
export async function closeLoop(
  kanban,
  { repoName, repoPath, dir, stem, blocked },
) {
  const full = join(repoPath, dir);
  const done = doneFile(full, stem);
  if (!done) return [];

  const text = readFileSync(join(full, done), "utf8");
  const body = resultsOf(text) ?? `Task complete — \`${dir}/${done}\``;

  // The card first, the issue second. The Kanban mirrors an issue comment back onto
  // the card, and it knows the copy for the same comment only when the card already
  // holds it. Issue first, the copy raced the SAID check below and nine cards showed
  // their Results twice (svelte-hasura-boilerplate#80). The issue is closed with `gh`
  // even when the Kanban is unset or failing.
  const card = await closeCard(kanban, {
    repoName,
    full,
    dir,
    stem,
    done,
    text,
    body,
  }).catch((err) => [`kanban: ${err.message}`]);
  const issue = await reportToIssue({ repoName, text, body, blocked });
  return [...issue, ...card];
}

async function closeCard(
  kanban,
  { repoName, full, dir, stem, done, text, body },
) {
  if (!hasKanban(kanban)) return [];
  const out = [];
  // A card the runner adopted for a card-less file (claim.js) is found by its path.
  const id =
    cardIdOf(text) ?? (await cardsAt(kanban, `${dir}/${stem}-TODO.md`))[0]?.id;
  if (!id) return [`no card id in ${done} — no card to close`];

  const board = await boardOf(kanban, repoName);
  if (!board) return [`no board connected to ${repoName}`];
  const listId = (name) =>
    board.lists.find((l) => l.name.toLowerCase() === name.toLowerCase())?.id;

  // Always point the card at the -DONE file so it links to the outcome even if
  // the Review list does not exist yet (e.g. board was just created).
  const review = listId(kanban.lists.review);
  if (review) {
    await runnerApi(kanban, "updateCard", {
      id,
      set: { list_id: review, task_file_path: `${dir}/${done}` },
    });
  } else {
    await runnerApi(kanban, "updateCard", {
      id,
      set: { task_file_path: `${dir}/${done}` },
    });
    out.push(
      `no "${kanban.lists.review}" list — card path updated but not moved`,
    );
  }

  // Always post Results as a comment; idempotent so re-runs don't duplicate it.
  const comments = await runnerApi(kanban, "comments", {
    todoId: id,
    content: body,
  });
  if (comments.length)
    out.push(
      `${review ? `card → ${kanban.lists.review}` : "card"} (results already posted)`,
    );
  else {
    await runnerApi(kanban, "createComment", {
      todoId: id,
      userId: board.user_id,
      content: body,
    });
    out.push(
      review
        ? `card → ${kanban.lists.review}, results posted`
        : `results posted (card not moved — create a "${kanban.lists.review}" list)`,
    );
  }
  // A failed upload must not undo the close above: the card has moved either way.
  const shots = await attachScreenshots(kanban, { full, stem, id }).catch(
    (err) => [`screenshots: ${err.message}`],
  );
  return [...out, ...shots];
}

/**
 * Card id → its -DONE/-BLOCKED file, for every finished task file in `full`, and
 * the `-TODO` path → finished file for those that name no card.
 */
export function finishedCards(full, dir = "") {
  const byCard = new Map();
  const byPath = new Map();
  for (const n of readdirSync(full)) {
    if (!/-(DONE|BLOCKED)\.md$/i.test(n)) continue;
    const id = cardIdOf(readFileSync(join(full, n), "utf8"));
    if (id) byCard.set(id, n);
    else byPath.set(`${dir}/${stemOf(n)}-TODO.md`, n);
  }
  return { byCard, byPath };
}

/**
 * Cards in TODO or Doing that still point at the -TODO file of a finished task.
 * closeLoop repoints a card at its -DONE file, so a card a human moved back to
 * TODO for a redo points there and is left alone; so is anything in another list.
 */
export function stuckCards(todos, byCard, lists) {
  const open = new Set([lists.todo, lists.doing].map((l) => l.toLowerCase()));
  return todos
    .filter(
      (t) =>
        byCard.has(t.id) &&
        open.has(t.list?.name?.toLowerCase()) &&
        /-TODO\.md$/i.test(t.task_file_path ?? "") &&
        stemOf(basename(t.task_file_path)) === stemOf(byCard.get(t.id)),
    )
    .map((t) => byCard.get(t.id));
}

/**
 * closeLoop only runs at the end of the runner's own run, so a task finished any
 * other way kept its card in TODO for good: by hand after a park (tekdok 027), on
 * a run a runner restart orphaned (tekdok 034), or on a peer whose close step never
 * ran (tekdok 035). Close those from the file, whoever renamed it.
 */
export async function reconcileCards(kanban, { repoName, repoPath, dir }) {
  if (!hasKanban(kanban)) return [];
  const { byCard, byPath } = finishedCards(join(repoPath, dir), dir);
  const todos = byCard.size
    ? await runnerApi(kanban, "cards", { ids: [...byCard.keys()] })
    : [];
  // Cards the runner adopted for card-less files (claim.js) still point at the -TODO.
  if (byPath.size)
    for (const t of (await cardsAt(kanban, ...byPath.keys())).todos) {
      if (byCard.has(t.id)) continue;
      byCard.set(t.id, byPath.get(t.task_file_path));
      todos.push(t);
    }
  const out = [];
  for (const name of stuckCards(todos, byCard, kanban.lists)) {
    const lines = await closeLoop(kanban, {
      repoName,
      repoPath,
      dir,
      stem: stemOf(name),
      blocked: /-BLOCKED\.md$/i.test(name),
    });
    out.push(`${name}: ${lines.join("; ")}`);
  }
  return out;
}
