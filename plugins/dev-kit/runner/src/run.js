#!/usr/bin/env node
/**
 * Local-clone runner: keep each repo clean and on its base branch, then run
 * /todo on the lowest unfinished task file. The -DONE.md rename is the state.
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
import { classify, downgrade, explicitTier } from "./classify.js";
import { usageLimitHit } from "./usage.js";
import { aiderArgs, aiderFailed, excludeAiderFiles } from "./aider.js";
import { herdrUp, paneLive, runInHerdr } from "./herdr.js";
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
import { blockedFile, listPending, pick, stemOf, todoDir } from "./queue.js";
import { machineFilter, machineOf, mine, myName } from "./machine.js";
import { claim } from "./claim.js";
import { issueOf } from "./issue.js";
import { cardIdOf, closeLoop, reconcileCards, titleOf } from "./kanban.js";
import {
  fileReview,
  finishMerged,
  forget,
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
import { fileFollowUps } from "./followup.js";
import { onboard } from "./onboard.js";
import { selfUpdate } from "./selfUpdate.js";
import { syncSecrets } from "./secrets.js";
import { trustProject } from "./trust.js";
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
 * `cwd` is the task's worktree in a pull request repo, else the clone itself.
 */
async function runTask({
  repoName,
  filename,
  number,
  repoPath,
  cwd,
  dir,
  tier,
}) {
  if (tier.engine === "aider") {
    excludeAiderFiles(repoPath);
    const r = await shell("aider", aiderArgs(tier, `${dir}/${filename}`), cwd);
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
    const r = await runInHerdr({
      name: `task-${number}`,
      cwd,
      prompt: `/todo ${number}`,
      args: cfg.unattended
        ? [...model, "--dangerously-skip-permissions"]
        : [...model, "--permission-mode", "acceptEdits"],
      taskMs: cfg.taskMinutes * 60000,
      done: () => !listPending(cwd, dir).some((p) => p.name === filename),
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
  return shell("claude", args, cwd);
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

/** `repo#stem` → task-file mtime, for tasks whose card another runner holds. */
const theirs = new Map();

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
  await reconcile(repoName, repoPath, dir);

  const viaPr = prFlow(cfg, repoName);
  const base = await baseBranch(repoPath);
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
    ];
    for (const line of lines) log(`  ${repoName} ⇄ ${line}`);
    // The task folder moved under us: look again on the next tick.
    if ((await head()) !== was) return false;
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

  // Another machine's tasks stay in the list (they are still pending, and their
  // attempt counts are still ours to prune) but are never picked here — nor is one
  // whose card another runner holds, nor one waiting on its `> After:` PR.
  const ready = [];
  for (const t of mine(pending, machineFilter(cfg))) {
    if (theirs.get(`${repoName}#${t.stem}`) === t.mtime) continue;
    if (t.after.length && (await waiting(repoName, t).catch(() => t.after[0])))
      continue;
    ready.push(t);
  }
  const task = await pick(repoName, ready);
  if (!task) return false;
  if (cfg.useHerdr && (await paneLive(`task-${task.number}`))) {
    log(`skip ${repoName} — ${task.name} is still running in its pane`);
    return false;
  }
  const me = myName(cfg);
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
      theirs.set(`${repoName}#${task.stem}`, task.mtime);
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
  const tier = explicitTier(content) ?? (await classify(content.slice(0, 500)));
  const attempt = state.addTry(repoName, taskStem, mtime);
  log(`▶ ${repoName} ${filename} (${tier.label}, attempt ${attempt})`);

  let cwd = repoPath;
  if (viaPr) {
    try {
      cwd = await openWorktree(repoPath, taskStem, base, log);
    } catch (err) {
      const why = err.stderr?.trim() || err.message;
      log(`✘ ${filename} — no worktree: ${why}`);
      await notify("Runner ✘ no worktree", `${repoName} ${filename}\n\n${why}`);
      return true;
    }
  }

  const { stdout: before } = await git(["rev-parse", "HEAD"], cwd);
  // Claude Code names its transcript after the session, not the task, so the
  // only handle we get on "the file this run wrote" is the clock (#21 step 1).
  const runStartMs = Date.now();

  // The CLI only tells us the usage wall was hit after the fact. A cheaper
  // tier spends the budget slower, so try stepping down before giving up and
  // waiting for the reset — same task, same tick.
  let activeTier = tier;
  let code,
    output,
    started = true,
    retriedStart = false,
    waitingOnLimit = false;
  for (;;) {
    const r = await runTask({
      repoName,
      filename,
      number,
      repoPath,
      cwd,
      dir,
      tier: activeTier,
    });
    ({ code, output } = r);
    started = r.started !== false;
    // A pane that never registered an agent means the task never ran: herdr
    // lost the tab, or its shell was not up yet when the agent started. Both
    // clear on a second try, and a fresh pane costs seconds — so retry here,
    // in this tick, instead of burning an attempt on a wall the agent never
    // saw. Two of those retired task-032's first task before it ever spoke.
    if (!started && !retriedStart) {
      retriedStart = true;
      log(`  ${filename} — no agent in the pane, retrying once`);
      continue;
    }
    // Gemini via aider is not on the Claude budget; its output is not the CLI's.
    const limit = activeTier.engine ? null : usageLimitHit(output);
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
  let { stdout: after } = await git(["rev-parse", "HEAD"], cwd);

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
  // The run almost certainly touched the task file; adopt that mtime as ours so
  // only a *human* edit reads as "try this again".
  const taskFile = join(repoPath, dir, filename);
  const adopt = () =>
    existsSync(taskFile) &&
    state.seen(repoName, taskStem, statSync(taskFile).mtimeMs);
  adopt();
  // The stash rewrites the task file too; adopt that mtime as well, or it reads
  // as a human retry and the count resets — tekdok 024 ran "attempt 1" 3 times.
  const park = async () => {
    const parked = await parkDirty(repoPath, filename);
    adopt();
    return parked;
  };

  // A pull request repo keeps the worktree for the retry; the clone was never touched.
  if (waitingOnLimit) return true;

  if (viaPr)
    return finishPrRun({
      repoName,
      repoPath,
      cwd,
      dir,
      base,
      filename,
      content,
      failed:
        code === 0
          ? null
          : started
            ? `exit ${code}`
            : "the agent never started in its pane",
      output,
      tier: activeTier,
    });

  if (code !== 0) {
    // Clear our own leftover dirt so a stuck run can't block the repo forever.
    const parked = await park();
    // "exit 1" over a two-line herdr error reads as "the agent failed"; it did
    // not run at all, which is a different thing to go and look at.
    const why = started
      ? `exit ${code}`
      : "the agent never started in its pane";
    log(`✘ ${filename} ${why}${parked ? " — parked leftover work" : ""}`);
    await notify(
      "Runner ✘",
      `${repoName} ${filename} ${why}${parked ? "\n\nUncommitted work parked in a stash — `git stash pop` to recover." : ""}\n\n${tail(output)}`,
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
    const parked = await park();
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

  return closeOut({
    repoName,
    repoPath,
    dir,
    filename,
    renamed,
    moved: after.trim() !== before.trim(),
    output,
    tier: activeTier,
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

  // Name the tier that actually ran: the requested one, or a cheaper one the
  // usage-limit path silently stepped down to — the only place the phone sees it.
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
}) {
  const stem = stemOf(filename);
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
  // The agent may have pushed the branch itself; with no PR on it, it is litter.
  if (shipped.bookkeeping)
    await git(["push", "origin", "--delete", shipped.branch], repoPath).catch(
      () => {},
    );
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
  log(`machine: ${cfg.machine ?? "(unset — takes every task)"}`);
  const isMine = machineFilter(cfg);
  const cooldown = state.cooldownUntil();
  if (cooldown) log(`⏳ usage limit — waiting until ${stamp(cooldown)}`);
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
    if (blocked[name]) log(`  ⛔ blocked: ${blocked[name]}`);
    const pending = listPending(repoPath, dir);
    const ours = new Set(mine(pending, isMine).map((p) => p.name));
    for (const p of pending) {
      const n = state.tries(name, p.stem, p.mtime);
      const who = ours.has(p.name)
        ? ""
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
