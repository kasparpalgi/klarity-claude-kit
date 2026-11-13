/**
 * A runner at its usage wall gives its queue away (klarity-claude-kit#12).
 *
 * The wall is this machine's Claude account, not the task's: the other runners bill
 * other accounts and are free. Before this, every task naming the Mac sat on the board
 * until the Mac's reset while dell and karel idled. Now, for as long as the cooldown
 * lasts, each tick puts this machine's waiting tasks back on Auto — the card's
 * `agent_machine` cleared, a bare `> Machine: mac` line dropped from the file in one
 * pushed commit — and the first free runner claims them the usual way (claim.js).
 *
 * It keeps:
 * - a `> Machine:` line with a note in brackets: that names a reason, not a preference;
 * - a task whose pane still works, or whose worktree holds commits on no remote —
 *   that work resumes here after the reset.
 * An Auto task counts only once this runner has started it: a claim is made to run.
 *
 * Opt-in per runner (`handOver` in config.json): the board pins some people's cards
 * to their own machine, and those must wait for it.
 */

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pushFiles, release } from "./claim.js";
import { cardIdOf } from "./kanban.js";
import { reasoned, withoutMachine } from "./machine.js";
import { parkDirty } from "./repo.js";
import { closeWorktree, onOrigin, worktreeOf } from "./worktree.js";

/**
 * Hand this machine's tasks in `pending` to any runner. `isMine` is machineFilter's,
 * `me` the name claims carry, `live(pane)` whether a herdr pane still works, `until`
 * the reset as the log shows it. Returns one line for the log and the phone, or null.
 * Throws when the push is refused: the cards stay on Auto and the next tick retries.
 */
export async function handOver({
  kanban,
  repoPath,
  dir,
  pending,
  isMine,
  me,
  until,
  live,
}) {
  const board = kanban?.endpoint && kanban?.adminSecret;
  const given = [];
  const files = [];
  for (const t of pending) {
    const text = readFileSync(t.path, "utf8");
    if (t.machine && (!isMine(t.machine) || reasoned(text))) continue;
    const tree = worktreeOf(repoPath, t.stem);
    const started = existsSync(tree);
    if (!t.machine && !started) continue;
    if (await live(`task-${t.number}`)) continue;
    if (started && !(await onOrigin("HEAD", tree))) continue;
    const card = cardIdOf(text);
    const freed = board && card ? await release(kanban, card, me) : false;
    if (!t.machine && !freed) continue;
    if (started) {
      await parkDirty(tree, `${t.stem} (handed over)`);
      await closeWorktree(repoPath, tree);
    }
    if (t.machine) {
      writeFileSync(t.path, withoutMachine(text));
      files.push(join(dir, t.name));
    }
    given.push(t.number);
  }
  if (!given.length) return null;
  const list = given.join(", ");
  const why = `${me} is at its usage limit until ${until}`;
  const message = `chore(todo): hand ${list} to any runner — ${why}`;
  if (files.length && !(await pushFiles(repoPath, files, message)))
    throw new Error(`could not push the hand-over of ${list}`);
  return `handed ${list} to any free runner — ${why}`;
}
