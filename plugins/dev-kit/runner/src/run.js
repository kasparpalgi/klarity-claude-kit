#!/usr/bin/env node
/**
 * Local-clone runner: git pull each repo, run /todo on any unfinished task file.
 * No Hasura, no admin secret. The -DONE.md rename is the only state.
 */

import { execFile, spawn } from "node:child_process";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { promisify } from "node:util";
import { classify, explicitTier } from "./classify.js";
import { loadConfig } from "./config.js";

const exec = promisify(execFile);
const cfg = loadConfig();
const log = (...args) =>
  console.log(new Date().toISOString().slice(11, 19), ...args);

function shell(cmd, args, cwd) {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, { cwd, env: process.env });
    let output = "";
    const collect = (c) => {
      output += c;
      process.stdout.write(c);
    };
    child.stdout.on("data", collect);
    child.stderr.on("data", collect);
    child.on("close", (code) => resolve({ code, output }));
    child.on("error", (err) => resolve({ code: 1, output: String(err) }));
  });
}

async function git(args, cwd) {
  return exec("git", args, { cwd });
}

/** Find first TODO file with no matching DONE (same NNN prefix). */
function findPending(repoPath) {
  const dir = join(repoPath, "doc", "todo");
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true }).filter((e) =>
      e.isFile(),
    );
  } catch {
    return null;
  }
  const done = new Set(
    entries
      .filter((e) => /-DONE\.md$/i.test(e.name))
      .map((e) => e.name.slice(0, 3)),
  );
  const todo = entries
    .map((e) => e.name)
    .filter((n) => /-TODO\.md$/i.test(n))
    .sort();
  for (const name of todo) {
    if (!done.has(name.slice(0, 3))) return { name, number: name.slice(0, 3) };
  }
  return null;
}

async function runRepo(repoName, repoPath) {
  const { stdout: status } = await git(["status", "--porcelain"], repoPath);
  if (status.trim()) {
    log(`skip ${repoName} — dirty working tree`);
    return false;
  }

  const pull = await shell("git", ["pull", "--ff-only"], repoPath);
  if (pull.code !== 0) {
    log(`skip ${repoName} — pull failed (diverged?)`);
    return false;
  }

  const pending = findPending(repoPath);
  if (!pending) return false;

  const { name: filename, number } = pending;
  const content = readFileSync(join(repoPath, "doc", "todo", filename), "utf8");
  const tier = explicitTier(content) ?? (await classify(content.slice(0, 500)));
  log(`▶ ${repoName} ${filename} (${tier.label})`);

  const { stdout: before } = await git(["rev-parse", "HEAD"], repoPath);
  const { code } = await shell(
    "claude",
    [
      "-p",
      `/todo ${number}`,
      "--model",
      tier.model,
      "--effort",
      tier.effort,
      "--dangerously-skip-permissions",
    ],
    repoPath,
  );
  const { stdout: after } = await git(["rev-parse", "HEAD"], repoPath);

  if (code !== 0) {
    log(`✘ ${filename} exit ${code}`);
    return true;
  }

  if (after.trim() !== before.trim()) {
    await shell("git", ["push", "origin", "main"], repoPath);
    log(`✔ ${filename} — committed and pushed`);
  } else {
    log(`✔ ${filename} — done (uncommitted; CLAUDE.md may forbid committing)`);
  }
  return true;
}

async function tick() {
  for (const [name, repoPath] of Object.entries(cfg.repos)) {
    if (await runRepo(name, repoPath)) return; // one task per tick
  }
}

if (process.argv.includes("--check")) {
  log("configured repos:");
  for (const [name, repoPath] of Object.entries(cfg.repos)) {
    const pending = findPending(repoPath);
    log(
      `  ${name} → ${repoPath}${pending ? `  [pending: ${pending.name}]` : ""}`,
    );
  }
} else {
  log(
    `watching ${Object.keys(cfg.repos).length} repo(s) every ${cfg.pollSeconds}s`,
  );
  for (;;) {
    await tick().catch((err) => log("tick failed:", err.message));
    await new Promise((r) => setTimeout(r, cfg.pollSeconds * 1000));
  }
}
