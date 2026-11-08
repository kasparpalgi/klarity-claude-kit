/**
 * A retry knows why the last attempt failed (svelte-hasura-boilerplate#72).
 *
 * The note rides in the `/todo` arguments, never in the task file: editing the
 * file resets the attempt count, and the run would loop forever. Attempt 1, and
 * any attempt with nothing recorded, gets the bare `/todo NNN` it always had.
 */

/**
 * Claude Code splits skill arguments shell-style for `$ARGUMENTS[0]`; quotes,
 * `;`, `#` or `$` in the note could swallow or break that split, so keep words only.
 */
const plain = (s) =>
  String(s)
    .replace(/[^\w\s.,:/@+=~-]/g, " ")
    .replace(/\s+/g, " ")
    .trim();

/** `last` is `{ why, stash?, log? }` as `state.setLast` stored it. */
export function todoPrompt(number, attempt, last) {
  const bare = `/todo ${number}`;
  if (attempt < 2 || !last?.why) return bare;
  const parts = [
    `This is attempt ${attempt}. Attempt ${attempt - 1} ended: ${last.why}.`,
    last.stash &&
      `Its uncommitted work is in stash commit ${last.stash}, see it with git stash show -p ${last.stash} and take it with git stash apply ${last.stash}.`,
    last.log && `Its transcript is ${last.log}.`,
    "Resume from that state, do not repeat finished investigation.",
  ];
  return `${bare} ${plain(parts.filter(Boolean).join(" "))}`;
}
