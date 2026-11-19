/**
 * A task that ran twice without a -DONE/-BLOCKED rename used to be skipped with a
 * phone notification, and its card sat in TODO until someone filed "why doesn't it
 * pick up?" (klarity-claude-kit#10). Now the skip also files a fixer task that reads
 * the stuck run's transcript and finishes the task, so the queue mends itself.
 *
 * An Auto task gives its card back, and its fixer is Auto too (#17): the Mac parked
 * ezyspace's 018 while holding its card, pinned the fixer to itself, then dropped off
 * the network, and karel, free again, skipped both as "claimed by another machine".
 * The task waits while its fixer is queued, so the two never run side by side.
 *
 * One fixer per task, and never a fixer for a fixer: a stuck fixer is a person's
 * problem, not a loop.
 */

import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { release } from "./claim.js";
import { cardIdOf, hasKanban } from "./kanban.js";
import { fileTask, nextNumber } from "./pr.js";

const FIXER = /^\d+-unstick\d+-/;
const fixerName = (number) => new RegExp(`^\\d+-unstick${number}-`);

/** The queued fixer of `task` in `pending`, or undefined: the task waits for it. */
export const fixerOf = (pending, task) =>
  pending.find((p) => fixerName(task.number).test(p.name));

/**
 * `> Run with:` and `> Machine:` for the fixer: the task's own tier, and the stuck
 * task's machine when it was addressed. The bracketed reason keeps it there even at
 * the usage wall (handover.js).
 */
function header(text, pin) {
  const tier = /^> Run with: .*$/m.exec(text)?.[0];
  const line = pin && `> Machine: ${pin} (the stuck run's log is here)`;
  return [tier, line].filter(Boolean).join("\n");
}

const unstickTask = (
  repoPath,
  dir,
  task,
  text,
  machine,
) => `${header(text, task.machine && machine)}

# Unstick task ${task.number}

## Original Requirement

[NEVER REMOVE]

The runner ran \`${dir}/${task.name}\` twice and neither run renamed it to -DONE or
-BLOCKED, so it is skipped now and its card waits in TODO.

Find out why: read that run's transcript${machine ? ` on ${machine}` : ""} \`${join(repoPath, dir, task.stem)}.log\` and the work it
left (\`git stash list\` — the runner parks a dirty run's work there). Then finish the
task itself: do what is left, append its \`## Results\` and rename it -DONE.md — or,
when a person must act, say exactly what and rename it -BLOCKED.md. If the cause is in
the runner or the /todo skill rather than the task, say so in this file's Results.
`;

/** Back on Auto, if this runner holds it: it will not run here again. */
async function giveBack(kanban, text, me) {
  const card = cardIdOf(text);
  return Boolean(me && card && hasKanban(kanban)) && release(kanban, card, me);
}

/**
 * Park `task` for good on `machine`: file its fixer unless one exists, then give an
 * Auto task's card back, never before, or a free runner could start the task ahead
 * of its fixer. Nothing for a fixer. Returns a log line or null.
 */
export async function fileUnstick({ kanban, repoPath, dir, task, machine }) {
  if (FIXER.test(task.name)) return null;
  const names = readdirSync(join(repoPath, dir));
  const text = readFileSync(join(repoPath, dir, task.name), "utf8");
  const lines = [];
  if (!names.some((n) => fixerName(task.number).test(n))) {
    const name = `${nextNumber(names)}-unstick${task.number}-TODO.md`;
    const filed = await fileTask(
      repoPath,
      dir,
      name,
      unstickTask(repoPath, dir, task, text, machine),
      `docs(todo): file ${name} — ${task.name} ran twice without finishing (runner)`,
    );
    lines.push(
      filed ? `filed ${name}` : `${name} — another runner filed it first`,
    );
  }
  if (!task.machine)
    lines.push(
      await giveBack(kanban, text, machine).then(
        (freed) => freed && "its card is back on Auto",
        (err) => `its card stays here: ${err.message}`,
      ),
    );
  return lines.filter(Boolean).join(", ") || null;
}
