/**
 * A tick's worth of cloud work for one repo (#86, see cloud.js). Each `> Machine: cloud`
 * task is in one of four places, checked in this order:
 *
 *   a PR carries it      in flight; said on the card once, then left to its merge
 *   its branch finished  the session pushed the rename: open the PR
 *   a session has it     sent on this very file (same mtime): leave it to work
 *   nothing yet          start a session — at most twice on an unchanged file
 *
 * Editing the task file is the human saying "again", as for a local run.
 * Returns log lines; every failure is one too, never a thrown tick.
 */

import { readFileSync } from "node:fs";
import { classify, explicitTier } from "./classify.js";
import { cloudPrompt, finishedOn, openCloudPr, startCloud } from "./cloud.js";
import { issueOf } from "./issue.js";
import { cardIdOf, titleOf } from "./kanban.js";
import { CLOUD } from "./machine.js";
import { notify } from "./notify.js";
import { prOf, prs, forget } from "./pr.js";
import { openStatus } from "./status.js";
import { trustProject } from "./trust.js";
import * as state from "./state.js";

export async function cloudTick({
  cfg,
  repoName,
  repoPath,
  dir,
  base,
  viaPr,
  tasks,
  log,
}) {
  if (!tasks.length) return [];
  const { open } = await prs(repoName);
  const out = [];
  for (const task of tasks) {
    const sent = state.cloudOf(repoName, task.stem);
    const text = readFileSync(task.path, "utf8");
    const card = (s) =>
      openStatus(cfg.kanban, {
        repoName,
        todoId: cardIdOf(text),
        machine: CLOUD,
        tier: s.tier,
        attempt: s.attempt,
        startMs: s.at,
        url: s.url,
        log,
      });
    let pr = prOf(task, open, dir, state.handedTo(repoName, task.stem));
    if (!pr && (await finishedOn(repoPath, dir, base, task.stem))) {
      pr = await openCloudPr({
        repoName,
        base,
        stem: task.stem,
        title: titleOf(text, task.name),
        issue: issueOf(text),
        url: sent?.url ?? "(started outside this runner)",
        draft: viaPr, // a PR repo's CI reviews a draft and merges it; elsewhere a person does
      });
      forget(repoName);
      out.push(`${task.name} — opened PR #${pr.number}`);
    }
    if (pr) {
      if (!sent || sent.pr) continue;
      state.sendCloud(repoName, task.stem, { ...sent, pr: pr.number });
      const say = await card(sent);
      await say("finished", { note: `PR #${pr.number} ${pr.url}` });
      await notify(
        "Runner ⇄ PR",
        `${repoName} ${task.name} · cloud\nPR #${pr.number} ${pr.url}\n${sent.url}`,
      );
      out.push(`${task.name} — PR #${pr.number} on the card`);
      continue;
    }
    if (sent?.mtime === task.mtime) continue;
    if (state.tries(repoName, task.stem, task.mtime) >= 2) continue;

    const tier =
      explicitTier(text) ??
      (await classify(text.slice(0, 500), cfg.classifier));
    const run = {
      tier: tier.label,
      attempt: state.addTry(repoName, task.stem, task.mtime),
      at: Date.now(),
    };
    const say = await card(run);
    trustProject(repoPath);
    try {
      const url = await startCloud({
        cwd: repoPath,
        prompt: cloudPrompt({ number: task.number, stem: task.stem, base }),
        tier,
      });
      state.sendCloud(repoName, task.stem, { ...run, url, mtime: task.mtime });
      await say("running", { url });
      await notify(
        "Runner ☁ cloud session",
        `${repoName} ${task.name} · ${tier.label}\n${url}`,
      );
      out.push(`${task.name} → ${url} (${tier.label})`);
    } catch (err) {
      await say("failed", { note: "the cloud session did not start" });
      await notify(
        "Runner ✘ cloud session did not start",
        `${repoName} ${task.name}\n\n${err.message}`,
      );
      out.push(
        `✘ ${task.name} — the cloud session did not start: ${err.message}`,
      );
    }
  }
  return out;
}
