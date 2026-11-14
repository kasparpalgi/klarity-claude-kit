/**
 * A repo has one current name, however many it was saved under (svelte-hasura-boilerplate#55).
 *
 * Boards, config keys and clone origins each hold a name from whenever they were written.
 * After `tektok-app/tektok-app` moved to `mytekdok/tektok-app` they disagreed, nothing
 * matched as a string, and every machine cloned a second copy without its `.env` files.
 * GitHub follows renames and transfers, so it decides whether two names are one repo.
 */

import { execFile } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { promisify } from "node:util";
import { runnerApi } from "./kanban.js";

const exec = promisify(execFile);

export const same = (a, b) => a?.toLowerCase() === b?.toLowerCase();

/**
 * The repo's current `owner/repo`; null when GitHub says it does not exist. Any other
 * failure throws: "could not ask" must never read as "a different repo", because the
 * callers would clone a second copy or delete the only one.
 */
export async function canonicalName(repo) {
  try {
    const { stdout } = await exec(
      "gh",
      ["api", `repos/${repo}`, "--jq", ".full_name"],
      { timeout: 30_000 },
    );
    return stdout.trim() || null;
  } catch (err) {
    if (/HTTP 404/.test(err.stderr ?? "")) return null;
    const why = String(err.stderr || err.message)
      .trim()
      .split("\n")[0];
    throw new Error(`cannot ask GitHub about ${repo}: ${why}`);
  }
}

/** Remembers answers for one sweep only: a daemon outlives the next rename. */
export function resolver(lookup = canonicalName) {
  const seen = new Map();
  return (repo) => {
    const k = repo.toLowerCase();
    if (!seen.has(k)) seen.set(k, lookup(repo));
    return seen.get(k);
  };
}

/** The `names` entry that is this repo: by spelling first, since that costs no request. */
export async function matchName(names, canon, name) {
  const spelled = names.find((n) => same(n, canon));
  if (spelled) return spelled;
  for (const n of names) if (same(await name(n), canon)) return n;
  return null;
}

/** Move a config entry to the repo's current name, with the lists that name it too. */
export function renameInConfig(path, from, to) {
  const file = JSON.parse(readFileSync(path, "utf8"));
  file.repos[to] = file.repos[from];
  delete file.repos[from];
  // A repo dropped from `pullRequests` would start pushing straight to its base branch.
  for (const list of ["pullRequests", "seo"])
    if (file[list])
      file[list] = file[list].map((r) => (same(r, from) ? to : r));
  writeFileSync(path, JSON.stringify(file, null, 2) + "\n");
}

/**
 * Point a board at the current name. The runner finds a repo's board by searching
 * `boards.github` for the config key, so a stale board leaves its cards out of Review.
 */
export async function retargetBoard(kanban, board, canon) {
  const [owner, repo] = canon.split("/");
  const github = JSON.stringify({
    ...JSON.parse(board.github),
    owner,
    repo,
    full_name: canon,
  });
  await runnerApi(kanban, "setBoardGithub", { id: board.id, github });
}
