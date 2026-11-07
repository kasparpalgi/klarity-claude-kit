#!/usr/bin/env node
/**
 * Board → runner, in one command.
 *
 * Connecting a board to a GitHub repo on the Kanban used to be step 1 of six: clone
 * the repo by hand on the Mac, again on Karel, hand-edit both `config.json`s, make a
 * task folder, enable the plugin. The boards already know every repo and whether it
 * belongs to a client, so this reads them and does the other five — on this machine
 * and, with `peers` configured, on the other one over ssh.
 *
 * Idempotent by construction: an existing config entry is never rewritten (paths
 * like `~/Documents/GitHub/ezy/ezy-iot` are placed by hand and must stay), and the
 * second machine pulls the setup commit the first one pushed.
 *
 * Being one command was still one command too many: a board connected on the phone
 * sat there doing nothing until someone remembered to run it (task-031). The daemon
 * now calls `onboard()` itself every `onboardMinutes`, so connecting the board is
 * the whole of it. Each machine does its own — no ssh from the tick loop.
 */

import { execFile } from "node:child_process";
import { readFileSync, readdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import {
  canonicalName,
  matchName,
  renameInConfig,
  resolver,
  retargetBoard,
  same,
} from "./canonical.js";
import { gql } from "./kanban.js";
import { scaffold } from "./scaffold.js";
import { restoreSecrets } from "./secrets.js";

const exec = promisify(execFile);
const HERE = dirname(dirname(fileURLToPath(import.meta.url)));
const CONFIG = process.env.KANBAN_RUNNER_CONFIG ?? join(HERE, "config.json");

// `boards.github` is text holding JSON, so the repo is parsed out here rather than
// filtered in the query. An archived board is not a project anyone is working on.
const BOARDS = `query { boards(
  where: {github: {_is_null: false}, archived_at: {_is_null: true}}
  order_by: {name: asc}
) { id name github client_id } }`;

/** A board opts its repo into claude-seo with `"seo": true` in its github JSON. */
export function seoOf(github) {
  try {
    return (typeof github === "string" ? JSON.parse(github) : github)?.seo === true;
  } catch {
    return false;
  }
}

/** `{"owner":"x","repo":"y"}` → `x/y`. Null for anything that is not a repo. */
export function repoOf(github) {
  try {
    const g = typeof github === "string" ? JSON.parse(github) : github;
    const full = g?.full_name ?? (g?.owner && g?.repo ? `${g.owner}/${g.repo}` : null);
    return /^[\w.-]+\/[\w.-]+$/.test(full ?? "") ? full : null;
  } catch {
    return null;
  }
}

/**
 * Where a repo lives on both machines. A board with a client is customer work and
 * goes under `customers/`; everything else sits at the code root.
 */
export const dirFor = (repo, hasClient, root = "~/Documents/GitHub") =>
  [root, hasClient ? "customers" : null, repo.split("/")[1]].filter(Boolean).join("/");

/** The boards this machine has no `repos` entry for yet, in board order. */
export function missing(repos, boards) {
  const seen = new Set(Object.keys(repos).map((r) => r.toLowerCase()));
  const out = [];
  for (const b of boards) {
    const repo = repoOf(b.github);
    if (!repo || seen.has(repo.toLowerCase())) continue;
    seen.add(repo.toLowerCase());
    out.push({ repo, board: b.name, hasClient: Boolean(b.client_id), seo: seoOf(b.github) });
  }
  return out;
}

/** `owner/repo` a checkout's origin points at, or null for anything else. */
export function originOf(dir) {
  try {
    const section = readFileSync(join(dir, ".git", "config"), "utf8")
      .split(/^\[/m)
      .find((s) => s.startsWith('remote "origin"]'));
    const url = /url\s*=\s*(\S+)/.exec(section ?? "")?.[1];
    return /[:/]([\w.-]+\/[\w.-]+?)(?:\.git)?$/.exec(url ?? "")?.[1] ?? null;
  } catch {
    return null;
  }
}

/** Every clone under the code root, with the `owner/repo` its origin names. */
function clones(root, depth = 3) {
  if (depth < 0) return [];
  let entries;
  try {
    entries = readdirSync(root, { withFileTypes: true });
  } catch {
    return [];
  }
  return entries.flatMap((e) => {
    if (!e.isDirectory() || e.name.startsWith(".")) return [];
    const dir = join(root, e.name);
    // A clone is a leaf: `customers/life-effect/` holds two, `customers/job` is one.
    const origin = originOf(dir);
    return origin ? [{ dir, origin }] : clones(dir, depth - 1);
  });
}

/**
 * The clone this repo already has, two levels under the code root. The convention
 * says where a *new* repo goes; it cannot know that `ezy-iot` was filed under
 * `ezy/` or that LifeEffect's board never got its client set. Cloning a second copy
 * beside the one being worked in is the worst outcome here, so origin decides.
 */
export function findClone(root, repo) {
  return clones(root).find((c) => same(c.origin, repo))?.dir ?? null;
}

/** Same, for an origin saved under another name: only GitHub can tell (#55). */
async function findRenamedClone(root, canon, name) {
  for (const { dir, origin } of clones(root))
    if (same(await name(origin), canon)) return dir;
  return null;
}

const expand = (dir) =>
  resolve(dir.startsWith("~/") ? join(homedir(), dir.slice(2)) : dir);

/** Config paths stay `~`-relative: the two machines have different home dirs. */
const tilde = (abs) => (abs.startsWith(homedir()) ? "~" + abs.slice(homedir().length) : abs);

/**
 * Where a board's repo lives, under its current name. `key` is the config entry it
 * already has, whatever name that was saved under. GitHub not knowing the repo leaves
 * the board's own name, and scaffolding reports the failed clone.
 */
async function locate(e, repos, root, name) {
  const canon = await name(e.repo);
  const repo = canon ?? e.repo;
  const names = Object.keys(repos);
  const key = canon
    ? await matchName(names, canon, name)
    : (names.find((n) => same(n, repo)) ?? null);
  const found = key
    ? repos[key]
    : (findClone(expand(root), repo) ??
      (canon ? await findRenamedClone(expand(root), canon, name) : null));
  return {
    ...e,
    repo,
    boardRepo: e.repo,
    key,
    dir: found ? tilde(found) : dirFor(repo, e.hasClient, root),
    found: Boolean(found),
    isNew: !key,
  };
}

/** Add the entries, keeping the file's own shape — it holds the admin secret. */
function addRepos(path, added) {
  const file = JSON.parse(readFileSync(path, "utf8"));
  for (const { repo, dir } of added) file.repos[repo] = dir;
  writeFileSync(path, JSON.stringify(file, null, 2) + "\n");
}

/** Run the same command on the other machine's clone of this runner. */
async function onPeer(host, dir, args) {
  // Same command means same code: without the pull the peer runs whatever version
  // of this file it last pulled, and reproduces bugs already fixed here.
  const cmd = `git -C ${dir} pull -q --ff-only; cd ${dir} && node src/onboard.js ${args.join(" ")}`;
  const { stdout, stderr } = await exec("ssh", [host, cmd], {
    timeout: 1_800_000,
    maxBuffer: 1 << 24,
  });
  return (stdout + stderr).trimEnd();
}

/**
 * One pass: every connected board this machine has no `repos` entry for gets a
 * clone, a scaffold and a config entry. Returns what landed — the daemon calls
 * this on a timer (task-031), so connecting a board is the only manual step left.
 */
export async function onboard({
  configPath = CONFIG,
  dryRun = false,
  all = false,
  install = true,
  peers = true,
  args = [],
  log = console.log,
  verbose = false,
  lookup = canonicalName,
} = {}) {
  const file = JSON.parse(readFileSync(configPath, "utf8"));
  const root = file.codeRoot ?? "~/Documents/GitHub";
  const kanban = { endpoint: file.endpoint, adminSecret: file.adminSecret };
  const { boards } = await gql(kanban, BOARDS);

  // `missing({})` is every connected board, deduped — one repo, two boards, one entry.
  const repos = file.repos ?? {};
  const name = resolver(lookup);
  const todo = [];
  const failed = [];
  for (const e of missing(all ? {} : repos, boards)) {
    let entry;
    try {
      entry = await locate(e, repos, root, name);
    } catch (err) {
      // Not knowing is no reason to clone: the next sweep asks again.
      failed.push({ ...e, why: err.message });
      continue;
    }
    if (!dryRun && entry.key && !same(entry.key, entry.repo)) {
      renameInConfig(configPath, entry.key, entry.repo);
      repos[entry.repo] = repos[entry.key];
      delete repos[entry.key];
      log(`${entry.key} is now ${entry.repo} — config.json updated`);
    }
    if (!dryRun && !same(entry.boardRepo, entry.repo))
      for (const b of boards.filter((b) => same(repoOf(b.github), entry.boardRepo)))
        await retargetBoard(kanban, b, entry.repo).then(
          () => log(`board ${b.name} now points at ${entry.repo}`),
          (err) => log(`  ⚠ board ${b.name} still says ${entry.boardRepo}: ${err.message}`),
        );
    // Two boards can name one repo under its old name and its new one.
    if ((all || entry.isNew) && !todo.some((t) => same(t.repo, entry.repo)))
      todo.push(entry);
  }
  if (verbose)
    log(
      `${boards.length} connected board(s); ${todo.length} ${all ? "to re-check" : `not in ${configPath.replace(homedir(), "~")}`}`,
    );

  const landed = [];
  for (const entry of todo) {
    log(
      `onboarding ${entry.repo} (board: ${entry.board}) → ${entry.dir}${entry.found ? "  [existing clone]" : ""}`,
    );
    const r = await scaffold(entry.repo, expand(entry.dir), {
      dryRun,
      install,
      // Either the board says so, or the repo is listed in config.json's `seo`.
      seo: entry.seo || (file.seo ?? []).some((r) => r.toLowerCase() === entry.repo.toLowerCase()),
    });
    for (const s of r.steps) log(`  ✔ ${s}`);
    for (const w of r.warnings) log(`  ⚠ ${w}`);
    // `landed` is what the config gained, so a dry run lands nothing by definition.
    if (r.failed) failed.push({ ...entry, why: r.warnings[0] ?? "scaffold failed" });
    else if (entry.isNew && !dryRun) {
      // A board back from the archive gets the `.env` its old clone left behind.
      if (restoreSecrets(entry.repo, expand(entry.dir))) log("  ✔ secrets restored");
      landed.push({ ...entry, stack: r.stack });
    }
  }

  if (dryRun) {
    if (verbose) log("\n--dry-run: config.json not written");
  } else if (landed.length) {
    addRepos(configPath, landed);
    log(`added ${landed.length} repo(s) to config.json — the runner reloads it each tick`);
  }

  for (const [host, dir] of Object.entries(peers ? (file.peers ?? {}) : {})) {
    log(`── ${host} ──`);
    try {
      log(await onPeer(host, dir, args.concat("--no-peers")));
    } catch (err) {
      log(`  ⚠ ${host} failed: ${String(err.message).split("\n")[0]}`);
    }
  }
  return { boards, todo, landed, failed };
}

async function main() {
  const flag = (f) => process.argv.includes(f);
  await onboard({
    dryRun: flag("--dry-run"),
    all: flag("--all"),
    install: !flag("--no-install"),
    peers: !flag("--no-peers"),
    args: process.argv.slice(2),
    verbose: true,
  });
}

if (process.argv[1] && resolve(process.argv[1]).endsWith("onboard.js"))
  await main();
