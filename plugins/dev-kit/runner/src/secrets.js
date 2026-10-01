#!/usr/bin/env node
/**
 * Mac → peers: the gitignored secrets a clone cannot bring with it.
 *
 * Onboarding gives every runner the repo, but `.env` is gitignored, so a peer got
 * the code and none of the keys — Dell had 0 of the Mac's 32 files, and a task that
 * needed a database URL failed there and passed here (#47). This machine is the
 * source: every file it holds that differs from the peer's copy is sent; files only
 * the peer has are never touched, so a peer-only override belongs in a file the Mac
 * does not have.
 *
 * Repos match by key, not path — `job` is `customers/job` here and `job` on Dell.
 */

import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { loadConfig } from "./config.js";

const exec = promisify(execFile);
const SSH = ["-o", "BatchMode=yes", "-o", "ConnectTimeout=10"];

/** `.env*` but not the committed templates, Hasura's CLI config, `.secrets/`. */
export const isSecret = (p) =>
  (/(^|\/)\.env[^/]*$/.test(p) && !/\.(example|sample)$/.test(p)) ||
  p === "hasura/config.yaml" ||
  /(^|\/)\.secrets\/$/.test(p);

/** Single-quoted for a remote shell. */
const q = (s) => `'${s.replaceAll("'", `'\\''`)}'`;

/** `~/x` → `"$HOME"/'x'`: the peer's home is not ours. */
const remotePath = (dir) =>
  dir.startsWith("~/") ? `"$HOME"/${q(dir.slice(2))}` : q(dir);

const walk = (root, rel) =>
  statSync(join(root, rel)).isDirectory()
    ? readdirSync(join(root, rel)).flatMap((n) => walk(root, join(rel, n)))
    : [rel];

/** Ignored-only, so a committed `.env` is git's job, not ours. `--directory` skips node_modules. */
export async function secretsOf(dir) {
  const { stdout } = await exec(
    "git",
    [
      "-C",
      dir,
      "ls-files",
      "-z",
      "--others",
      "--ignored",
      "--exclude-standard",
      "--directory",
    ],
    { maxBuffer: 1 << 26 },
  );
  const files = stdout
    .split("\0")
    .filter(isSecret)
    .flatMap((p) => walk(dir, p));
  return Object.fromEntries(
    files.map((f) => [
      f,
      createHash("sha256")
        .update(readFileSync(join(dir, f)))
        .digest("hex"),
    ]),
  );
}

/**
 * The peer's answer, `<i> ok` per clone it has and `<i> <hash>  <file>` per file,
 * → `[{ok, sums}]` by repo index. A file the peer lacks is simply absent.
 */
export function parseSums(text) {
  const out = [];
  for (const line of text.split("\n")) {
    const m = /^(\d+) (?:(ok)|([0-9a-f]{64}) [ *](.+))$/.exec(line);
    if (!m) continue;
    const r = (out[m[1]] ??= { ok: false, sums: {} });
    if (m[2]) r.ok = true;
    else r.sums[m[4]] = m[3];
  }
  return out;
}

/** The files whose peer copy is missing or different. */
export const stale = (local, remote) =>
  Object.keys(local).filter((f) => remote[f] !== local[f]);

const ssh = async (host, cmd) =>
  (
    await exec("ssh", [...SSH, host, cmd], {
      maxBuffer: 1 << 24,
      timeout: 120000,
    })
  ).stdout;

/** One peer: read its repo map, hash everything in one call, send what differs. */
async function syncPeer(host, runnerDir, mine, dryRun) {
  const theirs =
    JSON.parse(await ssh(host, `cat ${remotePath(`${runnerDir}/config.json`)}`))
      .repos ?? {};
  const dirOf = (repo) =>
    Object.entries(theirs).find(
      ([r]) => r.toLowerCase() === repo.toLowerCase(),
    )?.[1];
  // A repo the peer has not adopted yet is skipped; its own sweep clones it.
  const pairs = Object.entries(mine)
    .map(([repo, local]) => ({ repo, local, there: dirOf(repo) }))
    .filter((p) => p.there && Object.keys(p.local.sums).length);
  const script = pairs.map(
    ({ local, there }, i) =>
      `(cd ${remotePath(there)} 2>/dev/null && test -d .git && echo ${i} ok && sha256sum ${Object.keys(local.sums).map(q).join(" ")} 2>/dev/null | sed 's/^/${i} /')`,
  );
  const answer = parseSums(await ssh(host, script.join("; ") + "; true"));

  const sent = [];
  for (const [i, { repo, local, there }] of pairs.entries()) {
    if (!answer[i]?.ok) continue; // not cloned there yet
    const files = stale(local.sums, answer[i].sums);
    if (!files.length) continue;
    // COPYFILE_DISABLE: macOS tar otherwise adds `._.env` beside each file, which is
    // not gitignored, dirties the peer's tree and blocks the repo there.
    if (!dryRun)
      await exec("sh", [
        "-c",
        `COPYFILE_DISABLE=1 tar --no-xattrs -cf - -C ${q(local.dir)} ${files.map(q).join(" ")} | ssh ${SSH.join(" ")} ${q(host)} ${q(`tar -xf - -C ${remotePath(there)}`)}`,
      ]);
    sent.push(`${repo}: ${files.join(", ")}`);
  }
  return sent;
}

/**
 * Every peer in `config.json` → `{host: {sent, error}}`. A peer that is down is an
 * `error`, not a throw — the caller decides how loudly to say so.
 */
export async function syncSecrets({ log = console.log, dryRun = false } = {}) {
  const cfg = loadConfig();
  const mine = {};
  for (const [repo, dir] of Object.entries(cfg.repos))
    mine[repo] = { dir, sums: await secretsOf(dir).catch(() => ({})) };
  const out = {};
  for (const [host, runnerDir] of Object.entries(cfg.peers)) {
    try {
      const sent = await syncPeer(host, runnerDir, mine, dryRun);
      for (const line of sent) log(`🔑 ${host} ← ${line}`);
      out[host] = { sent, error: null };
    } catch (err) {
      out[host] = { sent: [], error: String(err.message).split("\n")[0] };
    }
  }
  return out;
}

if (process.argv[1] && resolve(process.argv[1]).endsWith("secrets.js")) {
  const dryRun = process.argv.includes("--dry-run");
  const out = await syncSecrets({ dryRun });
  for (const [host, { sent, error }] of Object.entries(out))
    console.log(
      `${host}: ${error ? `unreachable — ${error}` : sent.length ? `${sent.length} repo(s) ${dryRun ? "would be " : ""}updated` : "in sync"}`,
    );
}
