#!/usr/bin/env node
/**
 * Local-clone runner: keep each repo clean and on its base branch, then run
 * /todo on the lowest unfinished task file. The -DONE.md rename is the state.
 * Every skip is either self-healed or announced once — it never wedges quietly.
 */

import { spawn } from "node:child_process";
import { existsSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { classify, downgrade, explicitTier } from "./classify.js";
import { usageLimitHit } from "./usage.js";
import { herdrUp, runInHerdr } from "./herdr.js";
import { notify, tail } from "./notify.js";
import { loadConfig } from "./config.js";
import {
  git,
  ignoreLogs,
  commitTaskDir,
  dirtyPaths,
  parkDirty,
  preflight,
  autoFinish,
} from "./repo.js";
import { blockedFile, listPending, pick, stemOf, todoDir } from "./queue.js";
import { machineFilter, machineOf, mine } from "./machine.js";
import { cardIdOf, closeLoop } from "./kanban.js";
import { onboard } from "./onboard.js";
import { recordUsage } from "./sessionUsage.js";
import * as state from "./state.js";

let cfg = loadConfig();
const interactive = process.argv.includes("--interactive");
// Local wall-clock, not UTC: the human reading the log is in the machine's own
// timezone, and a UTC prefix here reads as "off by my offset" (task-018).
const clock = (ms = Date.now()) =>
  new Date(ms).toLocaleTimeString("en-GB", { hour12: false });
const stamp = (ms) =>
  new Date(ms).toLocaleString("en-GB", {
    dateStyle: "short",
    timeStyle: "short",
  });
const log = (...args) => console.log(clock(), ...args);

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
  const dir = todoDir(repoPath);
  const {
    reason,
    kind,
    settling,
    notes = [],
    handoff,
  } = await preflight(repoPath, dir, cfg.checkpointQuietSeconds);
  if (settling) {
    log(`skip ${repoName} — task files still settling`);
    return false;
  }
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
  state.pruneTries(
    repoName,
    pending.map((p) => p.stem),
  );

  if (handoff) {
    const task = pending.find((p) => p.number === handoff);
    if (task && state.tries(repoName, task.stem, task.mtime) < 3) {
      state.addTry(repoName, task.stem, task.mtime, 3);
      await notify(
        "Runner ↗ task on a branch",
        `${repoName} ${task.name}\n\n${notes.join("\n")}`,
      );
    }
  }

  // Another machine's tasks stay in the list (they are still pending, and their
  // attempt counts are still ours to prune) but are never picked here.
  const task = await pick(repoName, mine(pending, machineFilter(cfg)));
  if (!task) return false;
  let { name: filename } = task;
  const { stem: taskStem, number, mtime } = task;

  await ignoreLogs(join(repoPath, dir), repoPath);
  const logFile = join(
    repoPath,
    dir,
    filename.replace(/-TODO\.md$/i, "") + ".log",
  );
  const content = readFileSync(join(repoPath, dir, filename), "utf8");
  const tier = explicitTier(content) ?? (await classify(content.slice(0, 500)));
  const attempt = state.addTry(repoName, taskStem, mtime);
  log(`▶ ${repoName} ${filename} (${tier.label}, attempt ${attempt})`);

  const { stdout: before } = await git(["rev-parse", "HEAD"], repoPath);
  // Claude Code names its transcript after the session, not the task, so the
  // only handle we get on "the file this run wrote" is the clock (#21 step 1).
  const runStartMs = Date.now();

  // The CLI only tells us the usage wall was hit after the fact. A cheaper
  // tier spends the budget slower, so try stepping down before giving up and
  // waiting for the reset — same task, same tick.
  let activeTier = tier;
  let code,
    output,
    waitingOnLimit = false;
  for (;;) {
    const model = ["--model", activeTier.model, "--effort", activeTier.effort];
    ({ code, output } = await runTask({
      repoName,
      filename,
      number,
      repoPath,
      model,
    }));
    const limit = usageLimitHit(output);
    if (!limit) break;
    const cheaper = downgrade(activeTier);
    if (!cheaper) {
      state.setCooldown(limit.untilMs);
      // Hitting the usage wall is the account's state, not this task's fault —
      // give back the attempt we took at line ~139 so a run that started with
      // ~no budget left (task-018) doesn't count toward the 3-strikes skip.
      state.addTry(repoName, taskStem, mtime, -1);
      const until = stamp(limit.untilMs);
      log(
        `⏳ ${filename} — usage limit at ${activeTier.label}, waiting until ${until}`,
      );
      await notify(
        "Runner ⏳ usage limit",
        `${repoName} ${filename}\n\nWaiting until ${until}`,
      );
      waitingOnLimit = true;
      break;
    }
    log(
      `↓ ${filename} — usage limit at ${activeTier.label}, dropping to ${cheaper.label}`,
    );
    activeTier = cheaper;
  }
  let { stdout: after } = await git(["rev-parse", "HEAD"], repoPath);

  writeFileSync(logFile, output);
  log(`  log → ${logFile}`);

  // Before any early return: a run that hit the wall, failed or finished dirty
  // still spent tokens, and the transcript is on disk either way.
  const spent = await recordUsage(cfg.kanban, {
    repoName,
    repoPath,
    todoId: cardIdOf(content),
    sinceMs: runStartMs,
  }).catch((err) => `usage: not recorded — ${err.message}`);
  if (spent) log(`  ${spent}`);
  // The run almost certainly touched the task file; adopt that mtime as ours so
  // only a *human* edit reads as "try this again".
  const taskFile = join(repoPath, dir, filename);
  if (existsSync(taskFile))
    state.seen(repoName, taskStem, statSync(taskFile).mtimeMs);

  if (waitingOnLimit) return true;

  if (code !== 0) {
    // Clear our own leftover dirt so a stuck run can't block the repo forever.
    const parked = await parkDirty(repoPath, filename);
    log(`✘ ${filename} exit ${code}${parked ? " — parked leftover work" : ""}`);
    await notify(
      "Runner ✘",
      `${repoName} ${filename} exit ${code}${parked ? "\n\nUncommitted work parked in a stash — `git stash pop` to recover." : ""}\n\n${tail(output)}`,
    );
    return true;
  }

  // Exit 0 only means the agent stopped talking. Completion is the -DONE rename
  // plus a clean tree, and the runner checks both — 159 "finished" with neither.
  let left = await dirtyPaths(repoPath);

  // Dirt confined to the task folder is the run's own bookkeeping, not work the
  // agent abandoned — most often the deleted `-TODO` half of a rename whose
  // `-DONE` side it committed alone (task-013). preflight commits exactly this on
  // the next tick, so parking it here only stranded the card: the early return
  // below skipped the rename check, the push, the issue and closeLoop entirely.
  if (left.length && left.every((p) => p.startsWith(dir + "/"))) {
    await commitTaskDir(
      repoPath,
      dir,
      `docs(todo): finish ${filename} bookkeeping (runner)`,
    );
    ({ stdout: after } = await git(["rev-parse", "HEAD"], repoPath));
    left = await dirtyPaths(repoPath);
  }

  // Our file specifically, not "something numbered NNN" — a second task can share
  // the number, and then a namesake's -TODO would read as "we never renamed ours".
  const renamed = !listPending(repoPath, dir).some((p) => p.name === filename);

  if (left.length) {
    // A dirty finish is real work the agent never committed. preflight blocks on
    // any dirt, so left as-is it wedges this task and every card queued after it.
    // We cannot guess what belongs in a commit, so park it (recoverable) and warn.
    const parked = await parkDirty(repoPath, filename);
    const why = [
      renamed ? null : `${filename} was never renamed to -DONE`,
      parked
        ? `parked ${left.length} uncommitted path(s) in a stash — \`git stash pop\` to recover`
        : `uncommitted (could not park): ${left.slice(0, 6).join(", ")}`,
    ].filter(Boolean);
    log(`⚠ ${filename} — ran but did not finish: ${why.join("; ")}`);
    await notify(
      "Runner ⚠ did not finish",
      `${repoName} ${filename}\n\n${why.join("\n")}\n\n${tail(output)}`,
    );
    return true;
  }

  if (!renamed) {
    // Clean tree, file still -TODO: the agent did the work — or found nothing to
    // do (already complete / obsolete) — and walked past step 6. The repo is
    // whole, only the rename is missing, so finish it here instead of parking a
    // dead slot the human must rename by hand and re-running the same task three
    // times. This is the common "already complete, nothing to do" end (task-014).
    const done = await autoFinish(
      repoPath,
      dir,
      filename,
      after.trim() !== before.trim(),
    );
    ({ stdout: after } = await git(["rev-parse", "HEAD"], repoPath));
    log(
      `✔ ${filename} — agent skipped the rename; runner finished it as ${done}`,
    );
    filename = done;
  }

  if (after.trim() !== before.trim())
    await shell("git", ["push", "origin", "HEAD"], repoPath);

  // `-BLOCKED.md` is the agent saying "my half is done, the rest needs a person".
  // It is a finished run, not a failure — it just wants a different headline.
  const stem = stemOf(filename);
  const blocked = blockedFile(repoPath, dir, stem);
  log(
    blocked
      ? `⇥ ${blocked} — agent done, a human owns the rest`
      : `✔ ${filename} — committed and pushed`,
  );

  // The file side is finished; now say so on the card it came from.
  const { stdout: addedOut } = await git(
    [
      "diff",
      "--name-only",
      "--diff-filter=A",
      `${before.trim()}..${after.trim()}`,
    ],
    repoPath,
  );
  const added = addedOut.split("\n").filter(Boolean);
  const closed = await closeLoop(cfg.kanban, {
    repoName,
    repoPath,
    dir,
    stem,
    added,
    blocked: Boolean(blocked),
  }).catch((err) => [`kanban: ${err.message}`]);
  for (const line of closed) log(`  ${line}`);

  // Name the tier that actually ran: the requested one, or a cheaper one the
  // usage-limit path silently stepped down to — the only place the phone sees it.
  await notify(
    blocked ? "Runner ⇥ over to you" : "Runner ✔",
    `${repoName} ${blocked ?? filename} · ${activeTier.label}\n${closed.join("\n")}\n\n${tail(output)}`,
  );
  return true;
}

/**
 * Adopt boards connected since the last sweep. Connecting a board on the phone used
 * to leave the repo uncloned and unlisted until someone ran `npm run onboard` by
 * hand — which is how a new project looked like nothing had happened (task-031).
 *
 * This machine only: Karel runs the same daemon against the same boards and adopts
 * them itself, so an ssh pass from inside the tick loop would only duplicate it.
 */
let nextSweepMs = 0;
const announced = new Set();

async function sweepBoards() {
  if (!cfg.onboardMinutes || !cfg.kanban.endpoint || !cfg.kanban.adminSecret) return;
  if (Date.now() < nextSweepMs) return;
  nextSweepMs = Date.now() + cfg.onboardMinutes * 60000;
  const r = await onboard({ peers: false, log }).catch((err) => {
    log("board sweep failed:", err.message);
    return null;
  });
  if (!r) return;
  for (const e of r.landed) {
    announced.delete(e.repo);
    log(`＋ ${e.repo} → ${e.dir} — now watched`);
    await notify(
      "Runner ＋ new repo",
      `${e.repo} (board: ${e.board})\n\n${e.dir}${e.stack ? `\n${e.stack}` : ""}`,
    );
  }
  // Announce once: a repo that does not exist on GitHub yet would otherwise send
  // the same failure every sweep, forever.
  for (const e of r.failed) {
    if (!announced.has(e.repo))
      await notify("Runner ⚠ cannot onboard", `${e.repo} (board: ${e.board})\n\n${e.why}`);
    announced.add(e.repo);
  }
}

async function tick() {
  await sweepBoards();
  const cooldown = state.cooldownUntil();
  if (cooldown) {
    log(`⏳ waiting out usage limit until ${stamp(cooldown)}`);
    return;
  }
  const entries = Object.entries(cfg.repos);
  const last = state.getLastRepo();
  const lastIdx = last ? entries.findIndex(([n]) => n === last) : -1;
  const start = (lastIdx + 1) % entries.length;
  for (let i = 0; i < entries.length; i++) {
    const [name, repoPath] = entries[(start + i) % entries.length];
    if (await runRepo(name, repoPath)) {
      state.setLastRepo(name);
      return;
    }
  }
}

/** Read-only: what would the next tick see, and what is holding each repo up? */
async function check() {
  log(
    `herdr: ${cfg.useHerdr ? ((await herdrUp()) ? "up" : "ENABLED BUT DOWN") : "off"}`,
  );
  log(
    `machine: ${cfg.machine ?? "(unset — takes every task)"}${cfg.machineDefault ? " + unaddressed" : ""}`,
  );
  const isMine = machineFilter(cfg);
  const cooldown = state.cooldownUntil();
  if (cooldown) log(`⏳ usage limit — waiting until ${stamp(cooldown)}`);
  const { blocked } = state.snapshot();
  if (cfg.onboardMinutes && cfg.kanban.adminSecret) {
    try {
      const { boards, todo } = await onboard({ dryRun: true, peers: false, log: () => {} });
      const waiting = todo.map((t) => `${t.repo} → ${t.dir}`).join(", ");
      log(`boards: ${boards.length} connected; ${waiting || "all onboarded"}`);
    } catch (err) {
      log(`boards: could not read them — ${err.message}`);
    }
  }
  for (const [name, repoPath] of Object.entries(cfg.repos)) {
    const dir = todoDir(repoPath);
    const branch = await git(["branch", "--show-current"], repoPath).then(
      (r) => r.stdout.trim() || "DETACHED",
      () => "NOT A GIT REPO",
    );
    log(`${name} → ${repoPath}`);
    log(`  branch: ${branch}   task dir: ${dir}`);
    const dirty = await dirtyPaths(repoPath).catch(() => []);
    if (dirty.length) log(`  dirty: ${dirty.slice(0, 6).join(", ")}`);
    if (blocked[name]) log(`  ⛔ blocked: ${blocked[name]}`);
    const pending = listPending(repoPath, dir);
    const ours = new Set(mine(pending, isMine).map((p) => p.name));
    for (const p of pending) {
      const n = state.tries(name, p.stem, p.mtime);
      const who = ours.has(p.name)
        ? ""
        : `  [→ ${p.machine ?? "unaddressed"}, not this machine]`;
      log(
        `  pending: ${p.name}${n ? `  [${n} attempt(s)${n >= 2 ? ", skipped" : ""}]` : ""}${who}`,
      );
    }
  }
}

if (process.argv.includes("--check")) {
  await check();
} else if (process.argv.includes("--once")) {
  await tick(); // one pass, for tests and manual pokes
} else {
  log(
    `watching ${Object.keys(cfg.repos).length} repo(s) every ${cfg.pollSeconds}s`,
  );
  for (;;) {
    try {
      const next = loadConfig();
      if (Object.keys(next.repos).length !== Object.keys(cfg.repos).length)
        log(
          `watching ${Object.keys(next.repos).length} repo(s) every ${next.pollSeconds}s`,
        );
      cfg = next;
    } catch (err) {
      log("config reload failed, keeping previous config:", err.message);
    }
    await tick().catch((err) => log("tick failed:", err.message));
    await new Promise((r) => setTimeout(r, cfg.pollSeconds * 1000));
  }
}
