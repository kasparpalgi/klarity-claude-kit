/**
 * Which computer a task belongs to.
 *
 * Two machines now watch the same clones of the same repos — a Mac and an Ubuntu
 * box. Without an owner per task they would both pick the lowest `-TODO.md` on the
 * same tick and run it twice. The Kanban card names the machine, the task file
 * carries it as `> Machine: karel`, and each runner takes only its own.
 *
 * A file with no `> Machine:` line is *unaddressed* ("Auto" on the card): any
 * runner may take it, after claiming its Kanban card
 * (claim.js) so it never double-runs.
 */

/** `> Machine: cloud` — a Claude Code cloud session, not a computer (#86). */
export const CLOUD = "cloud";

const LINE = /^[ \t]*>?[ \t]*machine:[ \t]*(.+?)[ \t]*$/im;

/** `Karel Ubuntu` and `karel-ubuntu` are the same machine. */
export const slug = (s) =>
  String(s ?? "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");

/**
 * The machine a task file names, slugged — null when it names none. A note in
 * brackets is dropped: `mac (the only one that can ssh renlog)` slugged whole
 * matched no runner, so the task waited forever (klarity-claude-kit#10).
 */
export const machineOf = (text) =>
  slug(LINE.exec(text ?? "")?.[1]?.replace(/\s*\(.*$/, "")) || null;

/**
 * A note in brackets says why the task needs that machine (`mac (the only one that
 * can ssh renlog)`), so a runner at its usage wall keeps it (handover.js).
 */
export const reasoned = (text) => /\(/.test(LINE.exec(text ?? "")?.[1] ?? "");

/** The file with no `> Machine:` line: Auto again, any runner may claim it. */
export const withoutMachine = (text) =>
  text.replace(new RegExp(`${LINE.source}\\n?`, LINE.flags), "");

/** The id this runner writes into a claim — the first spelling it answers to. */
export const myName = ({ machine }) =>
  [machine ?? []].flat().map(slug).find(Boolean) ?? null;

/**
 * `(machine) => boolean` for "is this task mine?", over the slug `machineOf`
 * returned. With no `machine` configured the runner is the only one there is and
 * takes everything, exactly as before.
 *
 * `machine` may be a list, because a task addressed to a name no runner answers to
 * sits in the queue forever — silently. Accepting `["karel", "karel-ubuntu"]` costs
 * nothing and absorbs the board spelling its label differently than the config does.
 */
export function machineFilter({ machine }) {
  const me = new Set([machine ?? []].flat().map(slug).filter(Boolean));
  // Never run here, whoever we are: cloud.js sends it to a cloud session.
  return (want) => want !== CLOUD && (!me.size || !want || me.has(want));
}

/**
 * True when `want` names no runner in `machines` (config) — not even this one. Such a
 * task waits forever: `> Machine: manual` parked svelte-todo-kanban's 234 like that,
 * its card still in TODO, and nothing said why (klarity-claude-kit#14). Without a
 * `machines` list nobody is called unknown.
 */
export function nobodys({ machine, machines }, want) {
  const known = [machine ?? [], machines ?? [], CLOUD].flat().map(slug);
  return Boolean(want && machines?.length && !known.includes(want));
}

/** The subset of `pending` this machine owns. */
export const mine = (pending, isMine) =>
  pending.filter((t) => isMine(t.machine));
