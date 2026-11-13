#!/usr/bin/env node
/**
 * Local-clone runner: keep each repo clean and on its base branch, then run
 * /todo on the lowest unfinished task file — in a worktree of its own, so no agent
 * ever touches the clone (#91). The -DONE.md rename is the state.
 * Every skip is either self-healed or announced once — it never wedges quietly.
 */

import { spawn } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { classify, explicitTier } from "./classify.js";
import { usageLimitHit } from "./usage.js";
import { aiderArgs, aiderFailed, excludeAiderFiles } from "./aider.js";
import { herdrUp, paneLive, runInHerdr } from "./herdr.js";
import { onList, unpush, watchCard } from "./leave.js";
import { notify, tail } from "./notify.js";
import { loadConfig, prFlow } from "./config.js";
import {
  git,
  ignoreLogs,
  commitTaskDir,
  dirtyPaths,
  parkDirty,
  preflight,
  autoFinish,
  baseBranch,
} from "./repo.js";
import {
  blockedFile,
  listPending,
  pick,
  retired,
  sessionName,
  stemOf,
  todoDir,
} from "./queue.js";
import { CLOUD, machineFilter, machineOf, mine, myName } from "./machine.js";
import { cloudTick } from "./cloudTick.js";
import { waitingOnOrigin } from "./waiting.js";
import { feedback, sweepRework } from "./rework.js";
import { claim } from "./claim.js";
import { handOver } from "./handover.js";
import { issueOf } from "./issue.js";
import { cardIdOf, closeLoop, reconcileCards, titleOf } from "./kanban.js";
import { carryScreenshots } from "./screenshots.js";
import {
  fileReview,
  finishMerged,
  forget,
  lostFinish,
  prOf,
  prs,
  sweepPrs,
  waiting,
} from "./pr.js";
import {
  closeWorktree,
  landBookkeeping,
  openWorktree,
  shipBranch,
} from "./worktree.js";
import { catchUp, landWorktree } from "./land.js";
import { runnerTrees, sweepWorktrees } from "./sweep.js";
import { fileFollowUps } from "./followup.js";
import { onboard } from "./onboard.js";
import { offboard } from "./offboard.js";
import { selfUpdate } from "./selfUpdate.js";
import { syncSecrets } from "./secrets.js";
import { trustProject } from "./trust.js";
import { projectDir, recordUsage } from "./sessionUsage.js";
import { watchLink } from "./sessionLink.js";
import { todoPrompt } from "./retry.js";
import { costIn, openStatus } from "./status.js";
import * as state from "./state.js";
import { fileUnstick } from "./unstick.js";

let cfg = loadConfig();
const interactive = process.argv.includes("--interactive");
// Local wall-clock, not UTC: the human reading the log is in the machine's own
// timezone, and a UTC prefix here reads as "off by my offset" (task-018).
const clock = (ms = Date.now()) =>
  new Date(ms).toLocaleTimeString("en-GB", { hour12: false });
// With its zone ("08/11/2026, 00:11 EET"): a machine on UTC must not read as the
// CLI's own "resets 12:10am (Europe/Tallinn)" being off by the offset.
const stamp = (ms) =>
  new Date(ms).toLocaleString("en-GB", {
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
    timeZoneName: "short",
  });
const log = (...args) => console.log(clock(), ...args);

function shell(cmd, args, cwd, signal) {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, {
      cwd,
      signal,
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
 * Runner sessions commit as the machine's git user (Kaspar L. Palgi on all three) and
 * add no AI attribution lines to commits or pull requests. A file, not inline JSON:
 * herdr hands the argv on through a shell.
 */
const SESSION_SETTINGS = join(homedir(), ".kanban-runner", "session.json");
mkdirSync(dirname(SESSION_SETTINGS), { recursive: true });
writeFileSync(
  SESSION_SETTINGS,
  JSON.stringify({ attribution: { commit: "", pr: "" } }),
);

/**
 * Herdr path: a visible pane on the phone, permission prompts answerable there.
 * Falls back to the original headless child whenever herdr is off or down.
 * `cwd` is the task's worktree, never the clone itself.
 */
async function runTask({
  repoName,
  filename,
  number,
  prompt,
  repoPath,
  cwd,
  dir,
  tier,
  say,
  signal,
}) {
  if (tier.engine === "aider") {
    excludeAiderFiles(repoPath);
    const r = await shell(
      "aider",
      aiderArgs(tier, `${dir}/${filename}`),
      cwd,
      signal,
    );
    return aiderFailed(r.output) ? { ...r, code: r.code || 1 } : r;
  }
  const model = [
    "--model",
    tier.model,
    "--effort",
    tier.effort,
    "--settings",
    SESSION_SETTINGS,
  ];
  // Before the pane, not at clone time: a repo added to config.json by hand, or
  // cloned by the peer, never passed through onboarding.
  if (trustProject(cwd)) log("  trusted the folder for Claude");
  if (cfg.useHerdr && (await herdrUp())) {
    // Remote Control needs a TTY, so only the pane gets it, never `-p` (#85).
    const remote = cfg.remoteControl
      ? ["--remote-control", sessionName(repoName, filename)]
      : [];
    const r = await runInHerdr({
      name: `task-${number}`,
      cwd,
      prompt,
      args: cfg.unattended
        ? [...model, ...remote, "--dangerously-skip-permissions"]
        : [...model, ...remote, "--permission-mode", "acceptEdits"],
      taskMs: cfg.taskMinutes * 60000,
      done: () => retired(cwd, dir, stemOf(filename)),
      signal,
      blockedMs: cfg.blockedMinutes * 60000,
      // The card's status line links the session in claude.ai/code and the app.
      onRemote: remote.length
        ? (url) => {
            log(`  remote control: ${url}`);
            return say("running", { url });
          }
        : null,
      onBlocked: async (pane) => {
        await say("needs");
        await notify(
          "Runner ⏸ needs you",
          `${repoName} ${filename}\n\n${tail(pane)}`,
        );
      },
    });
    if (r.code) log(`  stuck in herdr${r.err ? `: ${r.err}` : " (blocked)"}`);
    return r;
  }
  if (cfg.useHerdr) log("  herdr down — falling back to headless");
  const args = ["-p", prompt, ...model];
  if (!interactive) args.push("--dangerously-skip-permissions");
  return shell("claude", args, cwd, signal);
}

/** HEAD each repo's cards were last reconciled at: once per new commit, not per tick. */
const reconciledAt = new Map();

async function reconcile(repoName, repoPath, dir) {
  const head = (await git(["rev-parse", "HEAD"], repoPath)).stdout.trim();
  const since = reconciledAt.get(repoName);
  if (since === head) return;
  reconciledAt.set(repoName, head);
  const lines = await reconcileCards(cfg.kanban, {
    repoName,
    repoPath,
    dir,
  }).catch((err) => [`kanban: ${err.message}`]);
  // Not on the first sweep after a start: with no `since`, the whole history would
  // count as new. A follow-up pushed while no runner was up is left for a human.
  if (since)
    lines.push(
      ...(await fileFollowUps(cfg.kanban, {
        repoName,
        repoPath,
        dir,
        since,
      }).catch((err) => [`follow-ups: ${err.message}`])),
    );
  for (const line of lines) log(`  ${repoName} ↺ ${line}`);
}

/**
 * `repo#stem` → the task-file mtime and when another runner held its card. Asked
 * again after ten minutes: a runner at its usage wall gives its claims back (#12).
 */
const theirs = new Map();
const THEIRS_MS = 10 * 60000;

/**
 * `repo#stem` → a session left running in its pane (#60). Its transcript stops
 * growing before the task's next run starts, so that run's clock never finds it:
 * record its usage here, once the pane has ended.
 */
const leftAlone = new Map();

async function recordLeftAlone(repoName) {
  for (const [key, run] of leftAlone) {
    if (!key.startsWith(`${repoName}#`) || (await paneLive(run.pane))) continue;
    leftAlone.delete(key);
    const spent = await recordUsage(cfg.kanban, run).catch(
      (err) => `usage: not recorded — ${err.message}`,
    );
    if (spent) log(`  ${key} ${spent}`);
  }
}

/** `repo#task` already pinged as waiting behind its repo's block (#66). */
const pinged = new Set();

async function announceWaiting(repoName, repoPath, dir, kind, reason) {
  if (kind === "fetch" || kind === "missing") return;
  const tasks = await waitingOnOrigin(repoPath, dir, machineFilter(cfg));
  for (const { name, card } of tasks) {
    if (pinged.has(`${repoName}#${name}`)) continue;
    pinged.add(`${repoName}#${name}`);
    // The card says why it sits there, not only the one ping hours ago (#5).
    await openStatus(cfg.kanban, {
      repoName,
      todoId: card,
      machine: myName(cfg),
      first: "waiting",
      note: `repo blocked: ${reason.split("\n")[0]}`,
      log,
    });
    log(`  ${repoName}: ${name} is waiting behind the block`);
    await notify(
      "Runner ⛔ task waiting",
      `${repoName} ${name} cannot start on ${myName(cfg) ?? "this machine"}:\n\n${reason}`,
    );
  }
}

async function runRepo(repoName, repoPath) {
  const dir = todoDir(repoPath);
  await recordLeftAlone(repoName);
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
    await announceWaiting(repoName, repoPath, dir, kind, reason);
    return false;
  }
  for (const n of notes) log(`  ${repoName}: ${n}`);
  if (state.clearBlocked(repoName))
    await notify("Runner ▶ unblocked", `${repoName} is running again.`);
  const viaPr = prFlow(cfg, repoName);
  const base = await baseBranch(repoPath);
  const swept = await sweepWorktrees({
    repoPath,
    dir,
    base,
    viaPr,
    live: (pane) => (cfg.useHerdr ? paneLive(pane) : false),
  }).catch((err) => ({ lines: [`worktree sweep: ${err.message}`] }));
  for (const line of swept.lines) log(`  ${repoName} ⌫ ${line}`);
  if (swept.landed) return false; // pulled by the next tick's preflight
  await reconcile(repoName, repoPath, dir);
  const all = listPending(repoPath, dir);
  let open = [];
  if (viaPr) {
    const seen = await prs(repoName).catch((err) => {
      log(
        `skip ${repoName} — cannot list pull requests: ${err.stderr?.trim() || err.message}`,
      );
      return null;
    });
    if (!seen) return false;
    open = seen.open;
    const handedTo = (stem) => state.handedTo(repoName, stem);
    const head = async () =>
      (await git(["rev-parse", "HEAD"], repoPath)).stdout;
    const was = await head();
    const lines = [
      ...(await finishMerged({
        repoPath,
        dir,
        pending: all,
        merged: seen.merged,
        handedTo,
      }).catch((err) => [`merged PRs: ${err.message}`])),
      ...(await sweepPrs({ repoPath, dir, base, open }).catch((err) => [
        `PR sweep: ${err.message}`,
      ])),
      ...(await feedback(repoName)
        .then((prs) => sweepRework({ repoPath, dir, prs, handedTo }))
        .catch((err) => [`review sweep: ${err.message}`])),
    ];
    for (const line of lines) log(`  ${repoName} ⇄ ${line}`);
    // The task folder moved under us: look again on the next tick.
    if ((await head()) !== was || lostFinish(lines)) return false;
  }
  // Cloud tasks never run here; the one runner with `cloud` sends them off (#86).
  // They bill this account too, so not while it is at its usage wall.
  const walled = state.cooldownUntil();
  if (cfg.cloud && !walled) {
    const lines = await cloudTick({
      cfg,
      repoName,
      repoPath,
      dir,
      base,
      viaPr,
      tasks: all.filter((t) => t.machine === CLOUD),
      log,
    }).catch((err) => [`cloud: ${err.stderr?.trim() || err.message}`]);
    for (const line of lines) log(`  ${repoName} ☁ ${line}`);
  }
  const pending = viaPr
    ? listPending(repoPath, dir, (t) =>
        Boolean(prOf(t, open, dir, state.handedTo(repoName, t.stem))),
      )
    : all;
  state.pruneTries(
    repoName,
    all.map((p) => p.stem),
  );
  state.pruneHanded(
    repoName,
    all.map((p) => p.stem),
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

  const me = myName(cfg);
  if (walled) {
    if (!cfg.handOver || !me) return false;
    // Nothing runs here until the reset: this machine's tasks go to a free one (#12).
    const line = await handOver({
      kanban: cfg.kanban,
      repoPath,
      dir,
      pending,
      isMine: machineFilter(cfg),
      me,
      until: stamp(walled),
      live: (pane) => (cfg.useHerdr ? paneLive(pane) : false),
    }).catch((err) => log(`  ${repoName} hand-over: ${err.message}`));
    if (line) {
      log(`  ${repoName} ↪ ${line}`);
      await notify("Runner ↪ handed over", `${repoName}\n\n${line}`);
    }
    return false;
  }
  // Another machine's tasks stay in the list (they are still pending, and their
  // attempt counts are still ours to prune) but are never picked here — nor is one
  // whose card another runner holds, nor one waiting on its `> After:` PR.
  const ready = [];
  for (const t of mine(pending, machineFilter(cfg))) {
    const held = theirs.get(`${repoName}#${t.stem}`);
    if (held?.mtime === t.mtime && Date.now() - held.at < THEIRS_MS) continue;
    if (t.after.length && (await waiting(repoName, t).catch(() => t.after[0])))
      continue;
    ready.push(t);
  }
  const task = await pick(repoName, ready, async (t) => {
    const line = await fileUnstick({ repoPath, dir, task: t, machine: me });
    if (line) log(`  ${repoName}: ${line}`);
    return line;
  });
  if (!task) return false;
  if (cfg.useHerdr && (await paneLive(`task-${task.number}`))) {
    log(`skip ${repoName} — ${task.name} is still running in its pane`);
    return false;
  }
  if (!task.machine && me) {
    const won = await claim(cfg.kanban, {
      repoPath,
      repoName,
      dir,
      task,
      me,
    }).catch((err) => {
      log(`skip ${repoName} — cannot claim ${task.name}: ${err.message}`);
      return null;
    });
    if (won === null) return false;
    if (!won) {
      theirs.set(`${repoName}#${task.stem}`, {
        mtime: task.mtime,
        at: Date.now(),
      });
      log(`skip ${repoName} — ${task.name} claimed by another machine`);
      return false;
    }
    log(`  ${repoName} ${task.name} — claimed for ${me}`);
    task.mtime = statSync(task.path).mtimeMs;
  }
  let { name: filename } = task;
  const { stem: taskStem, number, mtime } = task;

  await ignoreLogs(join(repoPath, dir), repoPath);
  const logFile = join(
    repoPath,
    dir,
    filename.replace(/-TODO\.md$/i, "") + ".log",
  );
  const content = readFileSync(join(repoPath, dir, filename), "utf8");
  const tier =
    explicitTier(content) ??
    (await classify(content.slice(0, 500), cfg.classifier));
  const attempt = state.addTry(repoName, taskStem, mtime);
  log(`▶ ${repoName} ${filename} (${tier.label}, attempt ${attempt})`);
  // Attempt 2+ hears how the one before ended (#72); attempt 1 is the bare /todo.
  const prompt = todoPrompt(
    number,
    attempt,
    state.lastEnding(repoName, taskStem, mtime),
  );
  if (prompt !== `/todo ${number}`) log(`  told: ${prompt}`);
  // On the card within this tick, edited as the run goes (#68).
  const say = await openStatus(cfg.kanban, {
    repoName,
    todoId: cardIdOf(content),
    machine: myName(cfg),
    tier: tier.label,
    attempt,
    log,
  });

  // Every task runs in a worktree of its own (#91), so the clone stays clean and on
  // its base branch whatever the session does: a pull request repo's on `todo/<stem>`,
  // a push-to-main repo's on `run/<stem>`, landed on the base branch when it ends.
  let cwd;
  try {
    cwd = await openWorktree(repoPath, taskStem, base, log, { direct: !viaPr });
  } catch (err) {
    const why = err.stderr?.trim() || err.message;
    log(`✘ ${filename} — no worktree: ${why}`);
    await say("failed", { note: "no worktree" });
    await notify("Runner ✘ no worktree", `${repoName} ${filename}\n\n${why}`);
    return true;
  }

  const { stdout: before } = await git(["rev-parse", "HEAD"], cwd);
  // Claude Code names its transcript after the session, not the task, so the
  // only handle we get on "the file this run wrote" is the clock (#21 step 1).
  const runStartMs = Date.now();

  let code,
    output,
    started = true,
    live = false,
    retriedStart = false,
    waitingOnLimit = false;
  // The tick loop is parked in this run, so watch the card from here (#73).
  const stop = new AbortController();
  const unwatch = watchCard({
    pollMs: cfg.pollSeconds * 1000,
    check: () => onList(repoPath, dir, filename, base),
    onLeft: () => {
      log(`⏹ ${filename} — its card left the agent list, stopping the run`);
      stop.abort();
    },
  });
  // The card links the session in claude.ai/code as soon as its transcript names it (#221).
  const unlink = watchLink({
    dir: projectDir(cwd),
    sinceMs: runStartMs,
    onUrl: (url) => {
      log(`  session: ${url}`);
      return say.link(url);
    },
  });
  for (;;) {
    const r = await runTask({
      repoName,
      filename,
      number,
      prompt,
      repoPath,
      cwd,
      dir,
      tier,
      say,
      signal: stop.signal,
    });
    ({ code, output, live } = r);
    started = r.started !== false;
    // A pane that never registered an agent means the task never ran: herdr
    // lost the tab, or its shell was not up yet when the agent started. Both
    // clear on a second try, and a fresh pane costs seconds — so retry here,
    // in this tick, instead of burning an attempt on a wall the agent never
    // saw. Two of those retired task-032's first task before it ever spoke.
    if (!started && !retriedStart && !stop.signal.aborted) {
      retriedStart = true;
      log(`  ${filename} — no agent in the pane, retrying once`);
      continue;
    }
    break;
  }
  unwatch();
  unlink();
  const stopped = stop.signal.aborted;
  // The CLI only says the usage wall was hit after the fact. The 5-hour and the
  // weekly wall cover every model and effort, so a cheaper tier meets the same
  // wall within seconds: server 026 burned three panes on it, tekdok 466 five,
  // and the fifth stalled herdr. Stop every repo until the reset instead.
  // Gemini via aider is not on the Claude budget; its output is not the CLI's.
  const limit = tier.engine || stopped ? null : usageLimitHit(output);
  if (limit) {
    state.setCooldown(limit.untilMs);
    // Hitting the usage wall is the account's state, not this task's fault —
    // give back the attempt we took at line ~139 so a run that started with
    // ~no budget left (task-018) doesn't count toward the 3-strikes skip.
    state.addTry(repoName, taskStem, mtime, -1);
    const until = stamp(limit.untilMs);
    log(
      `⏳ ${filename} — usage limit at ${tier.label}, waiting until ${until}`,
    );
    await notify(
      "Runner ⏳ usage limit",
      `${repoName} ${filename}\n\nWaiting until ${until}`,
    );
    waitingOnLimit = true;
    await say("waiting", { note: `usage limit, back ${until}` });
  }
  // Only our wait ended: the pane still works or waits on a human. Finishing now
  // closed the worktree under a live session (#60). Leave it, like the re-claim
  // guard does, and give the attempt back; a later tick picks it up once it ends.
  if (code && live) {
    state.addTry(repoName, taskStem, mtime, -1);
    leftAlone.set(`${repoName}#${taskStem}`, {
      pane: `task-${number}`,
      repoName,
      repoPath: cwd,
      todoId: cardIdOf(content),
      sinceMs: runStartMs,
    });
    log(`… ${filename} — still running in its pane, left alone`);
    return true;
  }

  writeFileSync(logFile, output);
  log(`  log → ${logFile}`);

  // Before any early return: a run that hit the wall, failed or finished dirty
  // still spent tokens, and the transcript is on disk either way.
  const spent = await recordUsage(cfg.kanban, {
    repoName,
    repoPath: cwd,
    todoId: cardIdOf(content),
    sinceMs: runStartMs,
  }).catch((err) => `usage: not recorded — ${err.message}`);
  if (spent) log(`  ${spent}`);
  const costUsd = costIn(spent);
  // The run almost certainly touched the task file; adopt that mtime as ours so
  // only a *human* edit reads as "try this again".
  const taskFile = join(repoPath, dir, filename);
  const adopt = () =>
    existsSync(taskFile) &&
    state.seen(repoName, taskStem, statSync(taskFile).mtimeMs);
  adopt();
  // The stash rewrites the task file too; adopt that mtime as well, or it reads
  // as a human retry and the count resets — tekdok 024 ran "attempt 1" 3 times.
  // Returns the stash commit, so the next attempt can be told where its work is.
  const park = async () => {
    const parked = await parkDirty(cwd, filename);
    adopt();
    if (!parked) return null;
    return (
      await git(["rev-parse", "--short", "stash@{0}"], cwd)
    ).stdout.trim();
  };
  const ended = (why, stash) =>
    state.setLast(repoName, taskStem, { why, stash, log: logFile });

  // The worktree stays for the retry, which reuses it; the clone was never touched.
  if (waitingOnLimit) return true;

  if (stopped) {
    // Not this task's failure: give the attempt back. The next tick pulls the
    // draft; moving the card back writes a fresh -TODO that queues normally.
    state.addTry(repoName, taskStem, mtime, -1);
    if (!viaPr) await unpush(cwd, base);
    const sha = await park();
    await closeWorktree(repoPath, cwd);
    await say("unfinished", { costUsd, note: "card left the agent list" });
    await notify(
      "Runner ⏹ stopped — card left the agent list",
      `${repoName} ${filename}\n\n${sha ? `Its work is parked in stash ${sha} — \`git stash apply ${sha}\` to recover.` : "It had changed nothing."}`,
    );
    return true;
  }

  if (viaPr) {
    const failed =
      code === 0
        ? null
        : started
          ? `exit ${code}`
          : "the agent never started in its pane";
    await say(failed ? "failed" : "finished", { costUsd, note: failed });
    return finishPrRun({
      repoName,
      repoPath,
      cwd,
      dir,
      base,
      filename,
      content,
      failed,
      output,
      tier,
      ended,
    });
  }

  // A push-to-main run ends in its worktree too (#91): what it left is parked there,
  // what it committed lands on the base branch from there, and the clone only ever
  // fast-forwards. Dirt confined to the task folder is a finished run's own
  // bookkeeping — most often the deleted `-TODO` half of a rename whose `-DONE` side
  // it committed alone (task-013) — so it is committed. Beside other dirt it is not:
  // a `-DONE` landed over uncommitted work is a false finish. Exit 0 only means the
  // agent stopped talking: completion is the rename plus a clean tree (159 had neither).
  let left = await dirtyPaths(cwd);
  if (code === 0 && left.length && left.every((p) => p.startsWith(dir + "/"))) {
    await commitTaskDir(
      cwd,
      dir,
      `docs(todo): finish ${filename} bookkeeping (runner)`,
    );
    left = await dirtyPaths(cwd);
  }
  const { stdout: after } = await git(["rev-parse", "HEAD"], cwd);
  // Our file specifically, not "something numbered NNN" — a second task can share
  // the number, and then a namesake's -TODO would read as "we never renamed ours".
  const renamed = !listPending(cwd, dir).some((p) => p.name === filename);
  const parked = left.length ? await park() : null;
  carryScreenshots(join(cwd, dir), join(repoPath, dir), taskStem);
  const landed = await landWorktree(repoPath, cwd, taskStem, base).catch(
    (err) => ({ error: err.stderr?.trim() || err.message }),
  );
  if (landed.error) {
    log(`✘ ${filename} — its commits did not land: ${landed.error}`);
    ended(`its commits did not land on ${base}, they are in ${cwd}`, parked);
    await say("failed", { costUsd, note: "did not land" });
    await notify(
      "Runner ✘ did not land",
      `${repoName} ${filename}\n\n${landed.error}\n\nThe work is still in ${cwd}.`,
    );
    return true;
  }
  if (landed.branch) {
    // Its CLAUDE.md asked for a branch per task: that waits for a person's merge.
    state.addTry(repoName, taskStem, mtime, 3);
    log(`↗ ${filename} — the session worked on ${landed.branch}, pushed there`);
    await say("unfinished", { costUsd, note: `on branch ${landed.branch}` });
    await notify(
      "Runner ↗ task on a branch",
      `${repoName} ${filename}\n\npushed ${landed.branch} — merge it into ${base}`,
    );
    return true;
  }
  if (landed.landed) log(`  landed ${landed.landed} commit(s) on ${base}`);
  const caughtUp = await catchUp(repoPath, base);

  if (code !== 0) {
    // "exit 1" over a two-line herdr error reads as "the agent failed"; it did
    // not run at all, which is a different thing to go and look at.
    const why = started
      ? `exit ${code}`
      : "the agent never started in its pane";
    log(`✘ ${filename} ${why}${parked ? " — parked leftover work" : ""}`);
    ended(why, parked);
    await say("failed", { costUsd, note: why });
    await notify(
      "Runner ✘",
      `${repoName} ${filename} ${why}${parked ? "\n\nUncommitted work parked in a stash — `git stash pop` to recover." : ""}\n\n${tail(output)}`,
    );
    return true;
  }

  if (left.length) {
    // A dirty finish is real work the agent never committed. We cannot guess what
    // belongs in a commit, so it is parked (recoverable) with a warning.
    const why = [
      renamed ? null : `${filename} was never renamed to -DONE`,
      parked
        ? `parked ${left.length} uncommitted path(s) in a stash — \`git stash pop\` to recover`
        : `uncommitted (could not park): ${left.slice(0, 6).join(", ")}`,
    ].filter(Boolean);
    log(`⚠ ${filename} — ran but did not finish: ${why.join("; ")}`);
    ended(
      `${renamed ? "" : "the task file was never renamed, and "}${left.length} changed files were left uncommitted`,
      parked,
    );
    await say("unfinished", { costUsd });
    await notify(
      "Runner ⚠ did not finish",
      `${repoName} ${filename}\n\n${why.join("\n")}\n\n${tail(output)}`,
    );
    return true;
  }

  await say("finished", { costUsd });
  if (!caughtUp) {
    // A person has the clone dirty or on another branch. The work is on origin;
    // reconcile moves the card once preflight has the clone caught up.
    log(`⚠ ${filename} — landed, but the clone is not on origin/${base} yet`);
    return true;
  }
  return closeOut({
    repoName,
    repoPath,
    dir,
    filename,
    renamed: !listPending(repoPath, dir).some((p) => p.name === filename),
    moved: after.trim() !== before.trim(),
    output,
    tier,
  });
}

/**
 * The end of every finished run on the base branch: rename a `-TODO` the agent left
 * (autoFinish), push, close the card and the issue, and tell the phone.
 */
async function closeOut({
  repoName,
  repoPath,
  dir,
  filename,
  renamed,
  moved,
  output,
  tier,
}) {
  const { stdout: before } = await git(["rev-parse", "HEAD"], repoPath);
  if (!renamed) {
    // Clean tree, file still -TODO: the agent did the work — or found nothing to
    // do (already complete / obsolete) — and walked past step 6. The repo is
    // whole, only the rename is missing, so finish it here instead of parking a
    // dead slot the human must rename by hand and re-running the same task three
    // times. This is the common "already complete, nothing to do" end (task-014).
    const done = await autoFinish(repoPath, dir, filename, { moved });
    log(
      `✔ ${filename} — agent skipped the rename; runner finished it as ${done}`,
    );
    filename = done;
  }
  const { stdout: after } = await git(["rev-parse", "HEAD"], repoPath);
  if (moved || after.trim() !== before.trim())
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
  const closed = await closeLoop(cfg.kanban, {
    repoName,
    repoPath,
    dir,
    stem,
    blocked: Boolean(blocked),
  }).catch((err) => [`kanban: ${err.message}`]);
  for (const line of closed) log(`  ${line}`);

  // Name the tier that ran — the only place the phone sees it.
  await notify(
    blocked ? "Runner ⇥ over to you" : "Runner ✔",
    `${repoName} ${blocked ?? filename} · ${tier.label}\n${closed.join("\n")}\n\n${tail(output)}`,
  );
  return true;
}

/**
 * A pull request repo's run ends in its worktree. Code goes up as the task's branch
 * and a PR — a draft when the runner opens it — and the task stays `-TODO` on the
 * base branch until that PR merges (pr.js). A session that changed only its task
 * file is bookkeeping, which may land on the base branch directly; one that changed
 * nothing is finished there as before.
 */
async function finishPrRun({
  repoName,
  repoPath,
  cwd,
  dir,
  base,
  filename,
  content,
  failed,
  output,
  tier,
  ended,
}) {
  const stem = stemOf(filename);
  // The worktree goes once the branch ships; its screenshots stay for closeLoop.
  carryScreenshots(join(cwd, dir), join(repoPath, dir), stem);
  let shipped;
  try {
    shipped = await shipBranch({
      repoName,
      path: cwd,
      stem,
      base,
      dir,
      title: titleOf(content, filename),
      issue: issueOf(content),
      bookkeeping: !failed,
    });
  } catch (err) {
    const why = err.stderr?.trim() || err.message;
    log(`✘ ${filename} — its branch did not ship: ${why}`);
    ended(`its branch did not ship, the work is still in the worktree ${cwd}`);
    await notify(
      "Runner ✘ branch did not ship",
      `${repoName} ${filename}\n\n${why}\n\nThe work is still in ${cwd}.`,
    );
    return true;
  }

  if (shipped.pr) {
    state.handOff(repoName, stem, shipped.pr);
    forget(repoName);
    await closeWorktree(repoPath, cwd);
    if (shipped.undone) {
      const filed = await fileReview({
        repoPath,
        dir,
        base,
        pr: shipped.undone,
      }).catch((err) => log(`  review for #${shipped.pr}: ${err.message}`));
      log(
        filed
          ? `  filed ${filed} — #${shipped.pr} is a draft again`
          : `  ⚠ no review filed for #${shipped.pr}, now a draft again`,
      );
    }
    const what = `${shipped.opened ? "opened draft" : "pushed to"} PR #${shipped.pr}${shipped.leftover ? " with the work it left uncommitted" : ""}`;
    log(`⇄ ${filename} — ${what}${failed ? ` after ${failed}` : ""}`);
    await notify(
      failed ? "Runner ✘ → draft PR" : "Runner ⇄ PR",
      `${repoName} ${filename} · ${tier.label}\n${what}\n${shipped.url}\n\n${tail(output)}`,
    );
    return true;
  }

  await closeWorktree(repoPath, cwd);
  if (failed) {
    log(`✘ ${filename} ${failed} — nothing on its branch`);
    ended(`${failed}, with nothing committed on its branch`);
    await notify(
      "Runner ✘",
      `${repoName} ${filename} ${failed}\n\n${tail(output)}`,
    );
    return true;
  }
  // Hours may have passed: catch the clone up before committing on it.
  await git(["pull", "--rebase"], repoPath);
  if (
    shipped.bookkeeping &&
    !(await landBookkeeping(repoPath, shipped.bookkeeping, dir, base))
  ) {
    log(`⚠ ${filename} — its task-file changes no longer apply to ${base}`);
    await notify(
      "Runner ⚠ did not finish",
      `${repoName} ${filename}\n\nThe session only changed its task file, and that change no longer applies to ${base}. It is on branch ${shipped.branch} (not pushed).`,
    );
    return true;
  }
  // The agent may have pushed the branch itself; with no PR on it, it is litter —
  // and so is the local branch, whose change is now on the base branch.
  if (shipped.bookkeeping) {
    await git(["push", "origin", "--delete", shipped.branch], repoPath).catch(
      () => {},
    );
    await git(["branch", "-D", shipped.branch], repoPath).catch(() => {});
  }
  return closeOut({
    repoName,
    repoPath,
    dir,
    filename,
    renamed: !listPending(repoPath, dir).some((p) => p.name === filename),
    moved: Boolean(shipped.bookkeeping),
    output,
    tier,
  });
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
  if (!cfg.onboardMinutes || !cfg.kanban.endpoint || !cfg.kanban.adminSecret)
    return;
  if (Date.now() < nextSweepMs) return;
  nextSweepMs = Date.now() + cfg.onboardMinutes * 60000;
  await retire();
  const r = await onboard({ peers: false, log }).catch((err) => {
    log("board sweep failed:", err.message);
    return null;
  });
  await pushSecrets();
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
      await notify(
        "Runner ⚠ cannot onboard",
        `${e.repo} (board: ${e.board})\n\n${e.why}`,
      );
    announced.add(e.repo);
  }
}

/** Archived or deleted boards: drop the repo here, and its clone unless it holds work (#65). */
async function retire() {
  const out = await offboard().catch((err) => {
    log("board retire failed:", err.message);
    return [];
  });
  for (const { repo, dir, kept } of out) {
    delete cfg.repos[repo]; // this tick must not preflight a clone that just went
    log(
      `－ ${repo} → ${dir} — ${kept ? `unwatched, clone kept: ${kept}` : "removed"}`,
    );
    await notify(
      "Runner － repo removed",
      `${repo} — its board is archived or deleted\n\n${kept ? `${dir} kept: ${kept}` : `${dir} deleted`}`,
    );
  }
}

/**
 * Push this machine's gitignored secrets to the peers, on the sweep's clock. Only the
 * source machine lists `peers`, so only it pushes. A board adopted on this sweep gets
 * its `.env` on the next, once the peer has cloned it too (#47).
 */
const unreachable = new Set();

async function pushSecrets() {
  if (!Object.keys(cfg.peers).length) return;
  const out = await syncSecrets({ log }).catch((err) => {
    log("secrets sync failed:", err.message);
    return {};
  });
  // Said on the edge: a peer that is switched off would otherwise log every sweep.
  for (const [host, { error }] of Object.entries(out)) {
    if (error && !unreachable.has(host))
      log(`🔑 ${host} unreachable: ${error}`);
    if (!error && unreachable.has(host)) log(`🔑 ${host} reachable again`);
    if (error) unreachable.add(host);
    else unreachable.delete(host);
  }
}

/**
 * Take any new runner code before picking up the next task, never during one.
 * Exiting is the whole mechanism: the supervisor restarts us unconditionally,
 * so the next tick runs the code that was just pulled.
 */
let nextUpdateMs = 0;

async function updateSelf() {
  if (Date.now() < nextUpdateMs) return;
  nextUpdateMs = Date.now() + 10 * 60000;
  const moved = await selfUpdate().catch((err) => {
    log("self-update skipped:", err.message);
    return null;
  });
  if (!moved) return;
  log(`${moved} — restarting on it`);
  process.exit(0);
}

async function tick() {
  await sweepBoards();
  const cooldown = state.cooldownUntil();
  if (cooldown) {
    log(`⏳ waiting out usage limit until ${stamp(cooldown)}`);
    // With `handOver` each repo still gets its tick, but only to give tasks away.
    if (!cfg.handOver || !cfg.machine) return;
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
  log(`machine: ${cfg.machine ?? "(unset — takes every task)"}`);
  if (cfg.cloud) log("cloud: sends `> Machine: cloud` tasks to cloud sessions");
  const isMine = machineFilter(cfg);
  const cooldown = state.cooldownUntil();
  if (cooldown)
    log(
      `⏳ usage limit — waiting until ${stamp(cooldown)}${cfg.handOver ? ", handing this machine's tasks over" : ""}`,
    );
  const { blocked } = state.snapshot();
  if (cfg.onboardMinutes && cfg.kanban.adminSecret) {
    try {
      const { boards, todo } = await onboard({
        dryRun: true,
        peers: false,
        log: () => {},
      });
      const waiting = todo.map((t) => `${t.repo} → ${t.dir}`).join(", ");
      log(`boards: ${boards.length} connected; ${waiting || "all onboarded"}`);
      for (const g of await offboard({ dryRun: true }))
        log(
          `boards: ${g.repo} is archived/deleted → ${g.kept ? `unwatch, keep clone (${g.kept})` : `remove ${g.dir}`}`,
        );
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
    const viaPr = prFlow(cfg, name);
    log(
      `  branch: ${branch}   task dir: ${dir}${viaPr ? "   via pull requests" : ""}`,
    );
    const open = viaPr
      ? await prs(name).then(
          (r) => r.open,
          (err) => {
            log(`  cannot list pull requests: ${err.message}`);
            return [];
          },
        )
      : [];
    const dirty = await dirtyPaths(repoPath).catch(() => []);
    if (dirty.length) log(`  dirty: ${dirty.slice(0, 6).join(", ")}`);
    for (const t of await runnerTrees(repoPath).catch(() => []))
      log(`  worktree: ${t}`);
    if (blocked[name]) log(`  ⛔ blocked: ${blocked[name]}`);
    const pending = listPending(repoPath, dir);
    const ours = new Set(mine(pending, isMine).map((p) => p.name));
    for (const p of pending) {
      const n = state.tries(name, p.stem, p.mtime);
      const sent = state.cloudOf(name, p.stem);
      const cloud = sent?.pr ? `PR #${sent.pr}` : (sent?.url ?? "not sent yet");
      const who = ours.has(p.name)
        ? ""
        : p.machine === CLOUD && cfg.cloud
          ? `  [☁ ${cloud}]`
          : `  [→ ${p.machine ?? "unaddressed"}, not this machine]`;
      const pr = viaPr && prOf(p, open, dir, state.handedTo(name, p.stem));
      const flight = pr ? `  [in PR #${pr.number}]` : "";
      const after = p.after.length
        ? `  [after ${p.after.map((a) => `#${a}`).join(", ")}]`
        : "";
      log(
        `  pending: ${p.name}${n ? `  [${n} attempt(s)${n >= 2 ? ", skipped" : ""}]` : ""}${who}${flight}${after}`,
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
    await updateSelf();
    await tick().catch((err) => log("tick failed:", err.message));
    await new Promise((r) => setTimeout(r, cfg.pollSeconds * 1000));
  }
}
