/**
 * Report the finished task back onto its GitHub issue.
 *
 * The task number and the issue number are deliberately the same, but only the file
 * may say so: `_GitHub issue #2 …_`, written by the Kanban when the card was filed.
 * We never infer an issue from the filename — repos whose task files predate that
 * convention would have their unrelated issue #33 closed by task 033.
 */

import { execFile } from "node:child_process";
import { promisify } from "node:util";

const run = promisify(execFile);

const ISSUE = /^_GitHub issue #(\d+)\b/m;

/** The issue a task file claims, or null when it claims none. */
export const issueOf = (text) => ISSUE.exec(text)?.[1] ?? null;

const gh = (args) => run("gh", args, { timeout: 30_000 });

/**
 * Comment the agent's own Results onto the issue, and close it — unless the task ended
 * `-BLOCKED.md`, where a person still owes the work and the issue must stay open.
 * Returns log lines; every failure is one of those, never a thrown error, because the
 * files and the card are already correct by the time we get here.
 */
export async function reportToIssue({ repoName, text, body, blocked }) {
  const number = issueOf(text);
  if (!number) return [];

  try {
    const { stdout } = await gh([
      "issue", "view", number, "--repo", repoName, "--json", "state",
    ]);
    if (JSON.parse(stdout).state !== "OPEN")
      return [`issue #${number} was already closed`];

    await gh(["issue", "comment", number, "--repo", repoName, "--body", body]);
    if (blocked) return [`issue #${number} commented, left open — a human owes the rest`];

    await gh(["issue", "close", number, "--repo", repoName]);
    return [`issue #${number} commented and closed`];
  } catch (err) {
    return [`issue #${number}: ${err.stderr?.trim() || err.message}`];
  }
}
