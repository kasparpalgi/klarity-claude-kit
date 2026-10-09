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
 */

import { readFileSync } from "node:fs";
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

const CLAIM = `mutation C($id: uuid!, $m: String!) {
  update_todos(
    where: {id: {_eq: $id}, _or: [{agent_machine: {_is_null: true}}, {agent_machine: {_ilike: $m}}]}
    _set: {agent_machine: $m}
  ) { affected_rows }
}`;

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

/**
 * true when this runner now owns the task, false when another one does. With no
 * Kanban, or no board for the repo, there is nothing to lock with and the task is
 * taken, as a lone runner always did.
 */
export async function claim(kanban, { repoName, dir, task, me }) {
  if (!kanban?.endpoint || !kanban?.adminSecret) return true;
  const text = readFileSync(task.path, "utf8");
  const id =
    cardIdOf(text) ??
    (await adopt(kanban, { repoName, path: join(dir, task.name), text }));
  if (!id) return true;
  const { update_todos } = await gql(kanban, CLAIM, { id, m: me });
  return update_todos.affected_rows === 1;
}
