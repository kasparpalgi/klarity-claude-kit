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
    // Run Claude in a herdr pane so it is visible/answerable from the phone.
    useHerdr: file.useHerdr ?? false,
    // No phone watching: skip permissions instead of stalling on a prompt.
    unattended: file.unattended ?? false,
    taskMinutes: file.taskMinutes ?? 45,
    blockedMinutes: file.blockedMinutes ?? 30,
    repos: Object.fromEntries(
      Object.entries(file.repos ?? {}).map(([name, dir]) => [
        name,
        expand(dir),
      ]),
    ),
  };
}
