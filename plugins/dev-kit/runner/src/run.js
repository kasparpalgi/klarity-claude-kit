#!/usr/bin/env node
/**
 * Local-clone runner: keep each repo clean and on its base branch, then run
 * /todo on the lowest unfinished task file. The -DONE.md rename is the state.
 * Every skip is either self-healed or announced once — it never wedges quietly.
 */

import { spawn } from "node:child_process";
import { existsSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { classify, explicitTier } from "./classify.js";
import { herdrUp, runInHerdr } from "./herdr.js";
import { notify, tail } from "./notify.js";
import { loadConfig } from "./config.js";
import { git, ignoreLogs, dirtyPaths, preflight } from "./repo.js";
import { listPending, pick, todoDir } from "./queue.js";
import { closeLoop } from "./kanban.js";
import * as state from "./state.js";

const cfg = loadConfig();
const interactive = process.argv.includes("--interactive");
const log = (...args) =>
  console.log(new Date().toISOString().slice(11, 19), ...args);

function shell(cmd, args, cwd) {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, {
      cwd,
      env: process.env,
      stdio: [interactive ? "inherit" : "ignore", "pipe", "pipe"],
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
        notify("Runner ⏸ needs you", `${repoName} ${filename}\n\n${tail(pane)}`),
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
  const dir = todoDir(repoPath);
  const { reason, kind, notes = [], handoff } = await preflight(repoPath, dir);
  if (reason) {
    log(`skip ${repoName} — ${reason}`);
    if (state.setBlocked(repoName, kind ?? reason))
      await notify("Runner ⛔ blocked", `${repoName}\n\n${reason}`);
    return false;
  }
  for (const n of notes) log(`  ${repoName}: ${n}`);
  if (state.clearBlocked(repoName))
    await notify("Runner ▶ unblocked", `${repoName} is running again.`);

  const pending = listPending(repoPath, dir);
  state.pruneTries(repoName, pending.map((p) => p.number));

  if (handoff) {
    const task = pending.find((p) => p.number === handoff);
    if (task && state.tries(repoName, handoff, task.mtime) < 3) {
      state.addTry(repoName, handoff, task.mtime, 3);
      await notify(
        "Runner ↗ task on a branch",
        `${repoName} ${task.name}\n\n${notes.join("\n")}`,
      );
    }
  }

  const task = await pick(repoName, pending);
  if (!task) return false;
  const { name: filename, number, mtime } = task;

  await ignoreLogs(join(repoPath, dir), repoPath);
  const logFile = join(repoPath, dir, filename.replace(/-TODO\.md$/i, "") + ".log");
  const content = readFileSync(join(repoPath, dir, filename), "utf8");
  const tier = explicitTier(content) ?? (await classify(content.slice(0, 500)));
  const attempt = state.addTry(repoName, number, mtime);
  log(`▶ ${repoName} ${filename} (${tier.label}, attempt ${attempt})`);

  const { stdout: before } = await git(["rev-parse", "HEAD"], repoPath);
  const model = ["--model", tier.model, "--effort", tier.effort];
  const { code, output } = await runTask({ repoName, filename, number, repoPath, model });
  const { stdout: after } = await git(["rev-parse", "HEAD"], repoPath);

  writeFileSync(logFile, output);
  log(`  log → ${logFile}`);
  // The run almost certainly touched the task file; adopt that mtime as ours so
  // only a *human* edit reads as "try this again".
  const taskFile = join(repoPath, dir, filename);
  if (existsSync(taskFile))
    state.seen(repoName, number, statSync(taskFile).mtimeMs);

  if (code !== 0) {
    log(`✘ ${filename} exit ${code}`);
    await notify("Runner ✘", `${repoName} ${filename} exit ${code}\n\n${tail(output)}`);
    return true;
  }

  // Exit 0 only means the agent stopped talking. Completion is the -DONE
  // rename plus a clean tree — 159 "finished" with neither and was reported ✔.
  const left = await dirtyPaths(repoPath);
  const renamed = !listPending(repoPath, dir).some((p) => p.number === number);
  if (!renamed || left.length) {
    const moved = after.trim() !== before.trim();
    const why = [
      renamed ? null : `${filename} was never renamed to -DONE`,
      left.length ? `uncommitted: ${left.slice(0, 6).join(", ")}` : null,
      // Clean tree + un-renamed file is almost always "the agent decided it was
      // done and walked past step 6" — the work is there, only the rename is not.
      !renamed && !left.length
        ? `tree is clean${moved ? `, it committed ${after.trim().slice(0, 8)}` : ""} — probably finished, just not renamed; rename it by hand`
        : null,
    ].filter(Boolean);
    log(`⚠ ${filename} — ran but did not finish: ${why.join("; ")}`);
    await notify(
      "Runner ⚠ did not finish",
      `${repoName} ${filename}\n\n${why.join("\n")}\n\n${tail(output)}`,
    );
    return true;
  }

  if (after.trim() !== before.trim())
    await shell("git", ["push", "origin", "HEAD"], repoPath);
  log(`✔ ${filename} — committed and pushed`);

  // The file side is finished; now say so on the card it came from.
  const { stdout: addedOut } = await git(
    ["diff", "--name-only", "--diff-filter=A", `${before.trim()}..${after.trim()}`],
    repoPath,
  );
  const added = addedOut.split("\n").filter(Boolean);
  const closed = await closeLoop(cfg.kanban, {
    repoName, repoPath, dir, number, added,
  }).catch((err) => [`kanban: ${err.message}`]);
  for (const line of closed) log(`  ${line}`);

  await notify(
    "Runner ✔",
    `${repoName} ${filename}\n${closed.join("\n")}\n\n${tail(output)}`,
  );
  return true;
}

async function tick() {
  for (const [name, repoPath] of Object.entries(cfg.repos)) {
    if (await runRepo(name, repoPath)) return; // one task per tick
  }
}

/** Read-only: what would the next tick see, and what is holding each repo up? */
async function check() {
  log(`herdr: ${cfg.useHerdr ? ((await herdrUp()) ? "up" : "ENABLED BUT DOWN") : "off"}`);
  const { blocked } = state.snapshot();
  for (const [name, repoPath] of Object.entries(cfg.repos)) {
    const dir = todoDir(repoPath);
    const branch = await git(["branch", "--show-current"], repoPath)
      .then((r) => r.stdout.trim() || "DETACHED", () => "NOT A GIT REPO");
    log(`${name} → ${repoPath}`);
    log(`  branch: ${branch}   task dir: ${dir}`);
    const dirty = await dirtyPaths(repoPath).catch(() => []);
    if (dirty.length) log(`  dirty: ${dirty.slice(0, 6).join(", ")}`);
    if (blocked[name]) log(`  ⛔ blocked: ${blocked[name]}`);
    for (const p of listPending(repoPath, dir)) {
      const n = state.tries(name, p.number, p.mtime);
      log(`  pending: ${p.name}${n ? `  [${n} attempt(s)${n >= 2 ? ", skipped" : ""}]` : ""}`);
    }
  }
}

if (process.argv.includes("--check")) {
  await check();
} else if (process.argv.includes("--once")) {
  await tick(); // one pass, for tests and manual pokes
} else {
  log(`watching ${Object.keys(cfg.repos).length} repo(s) every ${cfg.pollSeconds}s`);
  for (;;) {
    await tick().catch((err) => log("tick failed:", err.message));
    await new Promise((r) => setTimeout(r, cfg.pollSeconds * 1000));
  }
}
