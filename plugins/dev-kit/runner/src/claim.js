/**
 * "Auto" on a card means "whichever runner is free", not "the Mac".
 *
 * An unaddressed task used to belong to the one `machineDefault` runner, so a card
 * left on Auto sat in TODO on Dell and Karel while the Mac was busy or off
 * (tekdok-landing 007, svelte-hasura-boilerplate#50). Now any runner may take it,
 * but it claims the task first: it writes its own `> Machine:` line, commits and
 * pushes. A push is atomic, so of two runners racing for the same file exactly
 * one lands; the other drops its commit and pulls the winner's line next tick.
 */

import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { cardIdOf, gql } from "./kanban.js";
import { git } from "./repo.js";

const SET_MACHINE = `mutation C($id: uuid!, $m: String!) {
  update_todos_by_pk(pk_columns: {id: $id}, _set: {agent_machine: $m}) { id }
}`;

/** `> Machine: me` directly under the tier line — where the Kanban puts it. */
export function withMachine(text, me) {
  const line = `> Machine: ${me}`;
  const runWith = /^> Run with:.*$/m;
  if (runWith.test(text)) return text.replace(runWith, (m) => `${m}\n${line}`);
  return `${line}\n\n${text.replace(/^\s+/, "")}`;
}

/** true when this runner now owns the task; false when another one got there first. */
export async function claim(repoPath, dir, task, me, kanban) {
  const rel = join(dir, task.name);
  const text = readFileSync(task.path, "utf8");
  writeFileSync(task.path, withMachine(text, me));
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
  } catch {
    // Lost the race (or offline). Preflight left the tree clean, so this drops
    // exactly our claim commit and nothing else.
    await git(["reset", "--hard", "HEAD~1"], repoPath);
    return false;
  }
  // The board shows who took it, and a later rewrite of the file keeps the line.
  const id = cardIdOf(text);
  if (id && kanban?.adminSecret)
    await gql(kanban, SET_MACHINE, { id, m: me }).catch(() => {});
  return true;
}
