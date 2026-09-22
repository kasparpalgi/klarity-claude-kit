import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const DEFAULT_PATH = join(
  dirname(dirname(fileURLToPath(import.meta.url))),
  "config.json",
);

const expand = (dir) =>
  resolve(dir.startsWith("~/") ? join(homedir(), dir.slice(2)) : dir);

export function loadConfig(
  path = process.env.KANBAN_RUNNER_CONFIG ?? DEFAULT_PATH,
) {
  const file = JSON.parse(readFileSync(path, "utf8"));
  if (!Object.keys(file.repos ?? {}).length)
    throw new Error('config: "repos" is empty');
  return {
    pollSeconds: file.pollSeconds ?? 60,
    checkpointQuietSeconds: file.checkpointQuietSeconds ?? 60,
    // Run Claude in a herdr pane so it is visible/answerable from the phone.
    useHerdr: file.useHerdr ?? false,
    // No phone watching: skip permissions instead of stalling on a prompt.
    unattended: file.unattended ?? false,
    taskMinutes: file.taskMinutes ?? 45,
    blockedMinutes: file.blockedMinutes ?? 30,
    // This computer's id. Unset means "the only machine" — take every task.
    // Set, and a task file's `> Machine:` line has to name it (see machine.js).
    machine: file.machine ?? null,
    // Exactly one machine may also take the unaddressed tasks.
    machineDefault: file.machineDefault ?? false,
    // How often the daemon adopts newly connected boards. 0 turns it off and
    // `npm run onboard` goes back to being the only way in.
    onboardMinutes: file.onboardMinutes ?? 5,
    // Closing the card is optional: without an endpoint + adminSecret the runner
    // just does the files, exactly as before.
    kanban: {
      endpoint: file.endpoint ?? null,
      adminSecret: file.adminSecret ?? null,
      lists: { review: "Review", backlog: "Backlog", ...(file.lists ?? {}) },
    },
    repos: Object.fromEntries(
      Object.entries(file.repos ?? {}).map(([name, dir]) => [
        name,
        expand(dir),
      ]),
    ),
  };
}
