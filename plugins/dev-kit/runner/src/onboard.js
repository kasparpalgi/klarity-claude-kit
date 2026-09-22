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
 */

import { execFile } from "node:child_process";
import { readFileSync, readdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { gql } from "./kanban.js";
import { scaffold } from "./scaffold.js";

const exec = promisify(execFile);
const HERE = dirname(dirname(fileURLToPath(import.meta.url)));
const CONFIG = process.env.KANBAN_RUNNER_CONFIG ?? join(HERE, "config.json");

// `boards.github` is text holding JSON, so the repo is parsed out here rather than
// filtered in the query. An archived board is not a project anyone is working on.
const BOARDS = `query { boards(
  where: {github: {_is_null: false}, archived_at: {_is_null: true}}
  order_by: {name: asc}
) { name github client_id } }`;

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
    out.push({ repo, board: b.name, hasClient: Boolean(b.client_id) });
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

/**
 * The clone this repo already has, two levels under the code root. The convention
 * says where a *new* repo goes; it cannot know that `ezy-iot` was filed under
 * `ezy/` or that LifeEffect's board never got its client set. Cloning a second copy
 * beside the one being worked in is the worst outcome here, so origin decides.
 */
export function findClone(root, repo, depth = 3) {
  const want = repo.toLowerCase();
  if (depth < 0) return null;
  let entries;
  try {
    entries = readdirSync(root, { withFileTypes: true });
  } catch {
    return null;
  }
  for (const e of entries) {
    if (!e.isDirectory() || e.name.startsWith(".")) continue;
    const dir = join(root, e.name);
    // A clone is a leaf: `customers/life-effect/` holds two, `customers/job` is one.
    const origin = originOf(dir);
    if (origin) {
      if (origin.toLowerCase() === want) return dir;
      continue;
    }
    const found = findClone(dir, repo, depth - 1);
    if (found) return found;
  }
  return null;
}

const expand = (dir) =>
  resolve(dir.startsWith("~/") ? join(homedir(), dir.slice(2)) : dir);

/** Config paths stay `~`-relative: the two machines have different home dirs. */
const tilde = (abs) => (abs.startsWith(homedir()) ? "~" + abs.slice(homedir().length) : abs);

/** Add the entries, keeping the file's own shape — it holds the admin secret. */
function addRepos(path, added) {
  const file = JSON.parse(readFileSync(path, "utf8"));
  for (const { repo, dir } of added) file.repos[repo] = dir;
  writeFileSync(path, JSON.stringify(file, null, 2) + "\n");
}

/** Run the same command on the other machine's clone of this runner. */
async function onPeer(host, dir, args) {
  const cmd = `cd ${dir} && node src/onboard.js ${args.join(" ")}`;
  const { stdout, stderr } = await exec("ssh", [host, cmd], {
    timeout: 1_800_000,
    maxBuffer: 1 << 24,
  });
  return (stdout + stderr).trimEnd();
}

async function main() {
  const dryRun = process.argv.includes("--dry-run");
  const noInstall = process.argv.includes("--no-install");
  const file = JSON.parse(readFileSync(CONFIG, "utf8"));
  const root = file.codeRoot ?? "~/Documents/GitHub";
  const { boards } = await gql(
    { endpoint: file.endpoint, adminSecret: file.adminSecret },
    BOARDS,
  );

  // `missing({})` is every connected board, deduped — one repo, two boards, one entry.
  const known = new Map(
    Object.entries(file.repos ?? {}).map(([r, d]) => [r.toLowerCase(), d]),
  );
  const all = process.argv.includes("--all");
  const todo = missing(all ? {} : Object.fromEntries(known), boards).map((e) => {
    const configured = known.get(e.repo.toLowerCase());
    const found = configured ?? findClone(expand(root), e.repo);
    return {
      ...e,
      dir: found ? tilde(found) : dirFor(e.repo, e.hasClient, root),
      found: Boolean(found),
      isNew: !configured,
    };
  });
  console.log(
    `${boards.length} connected board(s); ${todo.length} ${all ? "to re-check" : `not in ${CONFIG.replace(homedir(), "~")}`}`,
  );

  const landed = [];
  for (const entry of todo) {
    console.log(
      `\n${entry.repo}  (board: ${entry.board})  → ${entry.dir}${entry.found ? "  [existing clone]" : ""}`,
    );
    const r = await scaffold(entry.repo, expand(entry.dir), {
      dryRun,
      install: !noInstall,
    });
    for (const s of r.steps) console.log(`  ✔ ${s}`);
    for (const w of r.warnings) console.log(`  ⚠ ${w}`);
    if (!r.failed && entry.isNew) landed.push(entry);
  }

  if (dryRun) console.log("\n--dry-run: config.json not written");
  else if (landed.length) {
    addRepos(CONFIG, landed);
    console.log(`\nadded ${landed.length} repo(s) to config.json — the runner reloads it each tick`);
  }

  const peers = process.argv.includes("--no-peers") ? {} : (file.peers ?? {});
  for (const [host, dir] of Object.entries(peers)) {
    console.log(`\n── ${host} ──`);
    try {
      console.log(await onPeer(host, dir, process.argv.slice(2).concat("--no-peers")));
    } catch (err) {
      console.log(`  ⚠ ${host} failed: ${String(err.message).split("\n")[0]}`);
    }
  }
}

if (process.argv[1] && resolve(process.argv[1]).endsWith("onboard.js"))
  await main();
