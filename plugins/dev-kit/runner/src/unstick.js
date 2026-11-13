/**
 * A task that ran twice without a -DONE/-BLOCKED rename used to be skipped with a
 * phone notification, and its card sat in TODO until someone filed "why doesn't it
 * pick up?" (klarity-claude-kit#10). Now the skip also files a fixer task that reads
 * the stuck run's transcript and finishes the task, so the queue mends itself.
 *
 * One fixer per task, and never a fixer for a fixer: a stuck fixer is a person's
 * problem, not a loop.
 */

import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileTask, nextNumber } from "./pr.js";

const FIXER = /^\d+-unstick\d+-/;

/** `> Run with:` and `> Machine:` for the fixer: the task's own tier, on this machine — the log is here. */
function header(text, machine) {
  const tier = /^> Run with: .*$/m.exec(text)?.[0];
  return [tier, machine && `> Machine: ${machine}`].filter(Boolean).join("\n");
}

const unstickTask = (
  repoPath,
  dir,
  task,
  text,
  machine,
) => `${header(text, machine)}

# Unstick task ${task.number}

## Original Requirement

[NEVER REMOVE]

The runner ran \`${dir}/${task.name}\` twice and neither run renamed it to -DONE or
-BLOCKED, so it is skipped now and its card waits in TODO.

Find out why: read that run's transcript \`${join(repoPath, dir, task.stem)}.log\` and the work it
left (\`git stash list\` — the runner parks a dirty run's work there). Then finish the
task itself: do what is left, append its \`## Results\` and rename it -DONE.md — or,
when a person must act, say exactly what and rename it -BLOCKED.md. If the cause is in
the runner or the /todo skill rather than the task, say so in this file's Results.
`;

/** File the fixer for `task` unless one exists or `task` is a fixer. Returns a log line or null. */
export async function fileUnstick({ repoPath, dir, task, machine }) {
  if (FIXER.test(task.name)) return null;
  const names = readdirSync(join(repoPath, dir));
  const mine = new RegExp(`^\\d+-unstick${task.number}-`);
  if (names.some((n) => mine.test(n))) return null;
  const text = readFileSync(join(repoPath, dir, task.name), "utf8");
  const name = `${nextNumber(names)}-unstick${task.number}-TODO.md`;
  const filed = await fileTask(
    repoPath,
    dir,
    name,
    unstickTask(repoPath, dir, task, text, machine),
    `docs(todo): file ${name} — ${task.name} ran twice without finishing (runner)`,
  );
  return filed ? `filed ${name}` : `${name} — another runner filed it first`;
}
