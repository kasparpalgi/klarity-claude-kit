/**
 * "Auto" on a card means "whichever runner is free", not "the Mac".
 *
 * Any runner may take an unaddressed task, but it claims it first — in the Kanban,
 * not in git. A claim used to be a pushed `> Machine:` commit on the base branch
 * (`chore(todo): claim NNN for karel`); once every change became a pull request
 * (tektok-app 184) nothing but finished task bookkeeping may land there.
 *
 * The card's `agent_machine` is set compare-and-swap: the update matches only while
 * the field is empty or already ours, so of two racing runners exactly one gets its
 * row back. A task with no card of its own — a failure CI filed, a review task an
 * agent wrote — is first adopted as a card in TODO; the first card in for its path
 * wins, the same lock `followup.js` files follow-ups with.
 *
 * With no Kanban to lock with, the old pushed claim line is the lock: it touches only
 * the task file, which is bookkeeping even in a pull request repo.
 */

import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  BOARD,
  CARDS_AT,
  DROP,
  NEW_CARD,
  cardIdOf,
  gql,
  titleOf,
} from "./kanban.js";
import { git } from "./repo.js";

const CLAIM = `mutation C($id: uuid!, $m: String!) {
  update_todos(
    where: {id: {_eq: $id}, _or: [{agent_machine: {_is_null: true}}, {agent_machine: {_ilike: $m}}]}
    _set: {agent_machine: $m}
  ) { affected_rows }
}`;

const CARD = `query K($id: uuid!) { todos_by_pk(id: $id) { id } }`;

/** The card already filed for `path`, the oldest when a race left two. */
export const cardAt = async (kanban, path) =>
  (await gql(kanban, CARDS_AT, { path })).todos[0]?.id ?? null;

/** A TODO card for a file that has none; null when the repo has no board to put it on. */
async function adopt(kanban, { repoName, path, text }) {
  const known = await cardAt(kanban, path);
  if (known) return known;
  const board = (await gql(kanban, BOARD, { repo: `%${repoName}%` }))
    .boards?.[0];
  const want = kanban.lists.todo.toLowerCase();
  const list = board?.lists.find((l) => l.name.toLowerCase() === want)?.id;
  if (!list) return null;
  const { insert_todos_one: card } = await gql(kanban, NEW_CARD, {
    o: {
      title: titleOf(text, path),
      content: text,
      list_id: list,
      user_id: board.user_id,
      task_file_path: path,
    },
  });
  const first = await cardAt(kanban, path);
  if (first !== card.id) await gql(kanban, DROP, { id: card.id });
  return first;
}

/** `> Machine: me` directly under the tier line — where the Kanban puts it. */
export function withMachine(text, me) {
  const line = `> Machine: ${me}`;
  const runWith = /^> Run with:.*$/m;
  if (runWith.test(text)) return text.replace(runWith, (m) => `${m}\n${line}`);
  return `${line}\n\n${text.replace(/^\s+/, "")}`;
}

/** Claim by pushing a `> Machine:` line; a push is atomic, so one runner lands it. */
async function pushClaim(repoPath, dir, task, me) {
  const rel = join(dir, task.name);
  writeFileSync(task.path, withMachine(readFileSync(task.path, "utf8"), me));
  try {
    await git(
      [
        "commit",
        "-m",
        `chore(todo): claim ${task.number} for ${me}`,
        "--",
        rel,
      ],
      repoPath,
    );
  } catch {
    await git(["checkout", "--", rel], repoPath);
    return false;
  }
  try {
    await git(["push", "origin", "HEAD"], repoPath);
    return true;
  } catch {
    await git(["reset", "--hard", "HEAD~1"], repoPath);
    return false;
  }
}

const swap = async (kanban, id, me) =>
  (await gql(kanban, CLAIM, { id, m: me })).update_todos.affected_rows === 1;

/** true or false as the board decides; null when there is no card to lock with. */
async function cardClaim(kanban, { repoName, dir, task, me }) {
  const text = readFileSync(task.path, "utf8");
  const named = cardIdOf(text);
  if (named) {
    if (await swap(kanban, named, me)) return true;
    // A card deleted since the file was written is not another runner's claim.
    if ((await gql(kanban, CARD, { id: named })).todos_by_pk) return false;
  }
  const path = join(dir, task.name);
  const id = await adopt(kanban, { repoName, path, text });
  if (!id) return null;
  if (!(await swap(kanban, id, me))) return false;
  // Two inserts in flight can each see their own card first; the later look decides.
  if ((await cardAt(kanban, path)) === id) return true;
  await gql(kanban, DROP, { id });
  return false;
}

/** true when this runner now owns the task, false when another one does. */
export async function claim(kanban, { repoPath, repoName, dir, task, me }) {
  const won =
    kanban?.endpoint && kanban?.adminSecret
      ? await cardClaim(kanban, { repoName, dir, task, me })
      : null;
  return won ?? pushClaim(repoPath, dir, task, me);
}
