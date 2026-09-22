/**
 * Which computer a task belongs to.
 *
 * Two machines now watch the same clones of the same repos — a Mac and an Ubuntu
 * box. Without an owner per task they would both pick the lowest `-TODO.md` on the
 * same tick and run it twice. The Kanban card names the machine, the task file
 * carries it as `> Machine: karel`, and each runner takes only its own.
 *
 * A file with no `> Machine:` line is *unaddressed*, and exactly one machine may
 * claim those (`machineDefault`) — otherwise every task file written before this
 * existed would double-run.
 */

const LINE = /^[ \t]*>?[ \t]*machine:[ \t]*(.+?)[ \t]*$/im;

/** `Karel Ubuntu` and `karel-ubuntu` are the same machine. */
export const slug = (s) =>
  String(s ?? "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");

/** The machine a task file names, slugged — null when it names none. */
export const machineOf = (text) => slug(LINE.exec(text ?? "")?.[1]) || null;

/**
 * `(machine) => boolean` for "is this task mine?", over the slug `machineOf`
 * returned. With no `machine` configured the runner is the only one there is and
 * takes everything, exactly as before.
 *
 * `machine` may be a list, because a task addressed to a name no runner answers to
 * sits in the queue forever — silently. Accepting `["karel", "karel-ubuntu"]` costs
 * nothing and absorbs the board spelling its label differently than the config does.
 */
export function machineFilter({ machine, machineDefault }) {
  const me = new Set([machine ?? []].flat().map(slug).filter(Boolean));
  if (!me.size) return () => true;
  return (want) => (want ? me.has(want) : Boolean(machineDefault));
}

/** The subset of `pending` this machine owns. */
export const mine = (pending, isMine) =>
  pending.filter((t) => isMine(t.machine));
