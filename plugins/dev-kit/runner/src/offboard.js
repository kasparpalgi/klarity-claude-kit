/**
 * Board archived or deleted → its repo leaves this machine (svelte-hasura-boilerplate#65).
 *
 * Onboarding only ever added. Archiving `kusp` left it cloned and watched on all four
 * runners, and deleting the clone by hand on the Mac just turned it into a repo the
 * runner reported as blocked every sweep. Each machine now runs this on its own sweep:
 * the config entry goes, and the clone goes with it unless it holds work that exists
 * nowhere else. Restoring the board needs nothing from here — with the entry gone,
 * onboarding sees a new board and clones it again, secrets included.
 */

import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { canonicalName, matchName, resolver } from "./canonical.js";
import { gql } from "./kanban.js";
import { repoOf } from "./onboard.js";
import { dirtyPaths, git } from "./repo.js";
import { saveSecrets } from "./secrets.js";
import * as state from "./state.js";

const CONFIG =
  process.env.KANBAN_RUNNER_CONFIG ??
  join(dirname(dirname(fileURLToPath(import.meta.url))), "config.json");
const BOARDS = `query { boards(where: {github: {_is_null: false}}) { github archived_at } }`;

const expand = (dir) =>
  resolve(dir.startsWith("~/") ? join(homedir(), dir.slice(2)) : dir);

/** Lower-cased repos of the boards that are not archived. */
export const liveRepos = (boards) => [
  ...new Set(
    boards
      .filter((b) => !b.archived_at)
      .map((b) => repoOf(b.github)?.toLowerCase())
      .filter(Boolean),
  ),
];

/**
 * Config repos no live board points at any more: those on an archived board, and
 * those a live board pointed at last sweep (`known`) — the board was deleted or
 * disconnected. A repo that never had a board was added by hand and stays.
 */
export function gone(repos, boards, known = []) {
  const live = new Set(liveRepos(boards));
  // An empty read is a broken read, never "every board was archived at once".
  if (!live.size) return [];
  const onABoard = new Set(boards.map((b) => repoOf(b.github)?.toLowerCase()));
  const wasLive = new Set(known);
  return Object.keys(repos).filter((r) => {
    const k = r.toLowerCase();
    return !live.has(k) && (onABoard.has(k) || wasLive.has(k));
  });
}

const count = async (args, dir) =>
  (await git(args, dir)).stdout.split("\n").filter(Boolean).length;

/** Why a clone must not be deleted: work that is not on GitHub. Null when safe. */
export async function whyKeep(dir) {
  try {
    const dirty = await dirtyPaths(dir);
    if (dirty.length)
      return `uncommitted changes — ${dirty.slice(0, 4).join(", ")}`;
    const ahead = await count(
      ["rev-list", "--branches", "--not", "--remotes"],
      dir,
    );
    if (ahead) return `${ahead} commit(s) not pushed`;
    const stashes = await count(["stash", "list"], dir);
    if (stashes) return `${stashes} stash(es)`;
    const trees = (
      await git(["worktree", "list", "--porcelain"], dir)
    ).stdout.match(/^worktree /gm);
    if (trees.length > 1) return `${trees.length - 1} open worktree(s)`;
    return null;
  } catch (err) {
    return `cannot read it with git — ${String(err.message).split("\n")[0]}`;
  }
}

function dropEntry(configPath, repo) {
  const file = JSON.parse(readFileSync(configPath, "utf8"));
  delete file.repos[repo];
  writeFileSync(configPath, JSON.stringify(file, null, 2) + "\n");
}

/** One pass → `[{repo, dir, kept}]`: `kept` says why the clone stayed, null if it went. */
export async function offboard({
  configPath = CONFIG,
  boards,
  dryRun = false,
  lookup = canonicalName,
} = {}) {
  const file = JSON.parse(readFileSync(configPath, "utf8"));
  boards ??= (
    await gql(
      { endpoint: file.endpoint, adminSecret: file.adminSecret },
      BOARDS,
    )
  ).boards;
  const repos = file.repos ?? {};
  const out = [];
  const name = resolver(lookup);
  const live = liveRepos(boards);
  for (const repo of gone(repos, boards, state.boarded())) {
    // A board moved to the repo's new name is not a retired board: this entry only
    // needs its name updating, which onboarding does, and the clone holds the `.env`.
    const canon = await name(repo);
    if (canon && (await matchName(live, canon, name))) continue;
    const dir = expand(repos[repo]);
    const kept = existsSync(dir) ? await whyKeep(dir) : null;
    out.push({ repo, dir: repos[repo], kept });
    if (dryRun) continue;
    if (existsSync(dir) && !kept) {
      await saveSecrets(repo, dir);
      rmSync(dir, { recursive: true, force: true });
    }
    dropEntry(configPath, repo);
    state.clearBlocked(repo);
  }
  if (!dryRun && live.length) state.setBoarded(live);
  return out;
}
