#!/usr/bin/env node
/**
 * Local-clone runner: git pull each repo, run /todo on any unfinished task file.
 * No Hasura, no admin secret. The -DONE.md rename is the only state.
 */

import { execFile, spawn } from "node:child_process";
import { existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { promisify } from "node:util";
import { classify, explicitTier } from "./classify.js";
import { herdrUp, runInHerdr } from "./herdr.js";
import { notify, tail } from "./notify.js";
import { loadConfig } from "./config.js";

const exec = promisify(execFile);
const cfg = loadConfig();
const interactive = process.argv.includes("--interactive");
const log = (...args) =>
  console.log(new Date().toISOString().slice(11, 19), ...args);

/**
 * Keep agent logs out of git so they never dirty the tree — and commit the
 * rule itself, or the untracked .gitignore would dirty it instead. Once per repo.
 */
async function ignoreLogs(dir, repoPath) {
  const file = join(dir, ".gitignore");
  const cur = existsSync(file) ? readFileSync(file, "utf8") : "";
  if (cur.includes("*.log")) return;
  writeFileSync(file, cur + "*.log\n");
  await git(["add", file], repoPath);
  await git(["commit", "-m", "chore: ignore runner task logs", file], repoPath);
}

function shell(cmd, args, cwd) {
  return new Promise((resolve) => {
    const stdin = interactive ? "inherit" : "ignore";
    const child = spawn(cmd, args, {
      cwd,
      env: process.env,
      stdio: [stdin, "pipe", "pipe"],
    });
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

function todoDir(repoPath) {
  const claude = join(repoPath, ".claude", "todo");
  try {
    readdirSync(claude);
    return claude;
  } catch {
    return join(repoPath, "doc", "todo");
  }
}

/** Find first TODO file with no matching DONE (same NNN prefix). */
function findPending(repoPath) {
  const dir = todoDir(repoPath);
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

/**
 * Herdr path: a visible pane on the phone, permission prompts answerable there.
 * Falls back to the original headless child whenever herdr is off or down.
 */
async function runTask({ repoName, filename, number, repoPath, model }) {
  if (cfg.useHerdr && (await herdrUp())) {
    const r = await runInHerdr({
      name: `task-${number}`,
      cwd: repoPath,
      prompt: `/todo ${number}`,
      args: cfg.unattended
        ? [...model, "--dangerously-skip-permissions"]
        : [...model, "--permission-mode", "acceptEdits"],
      taskMs: cfg.taskMinutes * 60000,
      blockedMs: cfg.blockedMinutes * 60000,
      onBlocked: (pane) =>
        notify(
          "Runner ⏸ needs you",
          `${repoName} ${filename}\n\n${tail(pane)}`,
        ),
    });
    if (r.code) log(`  stuck in herdr${r.err ? `: ${r.err}` : " (blocked)"}`);
    return r;
  }
  if (cfg.useHerdr) log("  herdr down — falling back to headless");
  const args = ["-p", `/todo ${number}`, ...model];
  if (!interactive) args.push("--dangerously-skip-permissions");
  return shell("claude", args, repoPath);
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
  const dir = todoDir(repoPath);
  await ignoreLogs(dir, repoPath);
  const logFile = join(dir, filename.replace(/-TODO\.md$/i, "") + ".log");
  const content = readFileSync(join(dir, filename), "utf8");
  const tier = explicitTier(content) ?? (await classify(content.slice(0, 500)));
  log(`▶ ${repoName} ${filename} (${tier.label})`);

  const { stdout: before } = await git(["rev-parse", "HEAD"], repoPath);
  const model = ["--model", tier.model, "--effort", tier.effort];
  const { code, output } = await runTask(
    { repoName, filename, number, repoPath, model },
  );
  const { stdout: after } = await git(["rev-parse", "HEAD"], repoPath);

  writeFileSync(logFile, output);
  log(`  log → ${logFile}`);

  if (code !== 0) {
    log(`✘ ${filename} exit ${code}`);
    await notify(
      "Runner ✘",
      `${repoName} ${filename} exit ${code}\n\n${tail(output)}`,
    );
    return true;
  }

  if (after.trim() !== before.trim()) {
    await shell("git", ["push", "origin", "main"], repoPath);
    log(`✔ ${filename} — committed and pushed`);
  } else {
    log(`✔ ${filename} — done (uncommitted; CLAUDE.md may forbid committing)`);
  }
  await notify("Runner ✔", `${repoName} ${filename}\n\n${tail(output)}`);
  return true;
}

async function tick() {
  for (const [name, repoPath] of Object.entries(cfg.repos)) {
    if (await runRepo(name, repoPath)) return; // one task per tick
  }
}

if (process.argv.includes("--check")) {
  log(`herdr: ${cfg.useHerdr ? ((await herdrUp()) ? "up" : "ENABLED BUT DOWN") : "off"}`);
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
