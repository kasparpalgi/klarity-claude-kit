/**
 * Pull requests, for a repo where every change is one (config `pullRequests`).
 *
 * There a task is done when its PR merges, not when its session exits: the file stays
 * `-TODO` on the base branch while the PR is open, so the queue skips it, and the
 * merge brings in the `-DONE` rename — or the runner makes it, once the PR is in.
 * Nobody watches the PRs either, so each sweep files a task for a draft that has no
 * review and for a green PR the merge job left open.
 */

import { execFile } from "node:child_process";
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { promisify } from "node:util";
import { autoFinish, git } from "./repo.js";
import { stemOf } from "./queue.js";

const run = promisify(execFile);
const gh = async (args) =>
  (await run("gh", args, { timeout: 60_000, maxBuffer: 1 << 26 })).stdout;

const FIELDS =
  "number,title,body,url,headRefName,isDraft,labels,createdAt,files,statusCheckRollup";

const MINUTE = 60_000;
/** A draft this young may still get the review task its own session is writing. */
export const DRAFT_GRACE_MS = 15 * MINUTE;
/** How long a green, ready PR may sit before the merge job is presumed broken. */
export const STUCK_MS = 30 * MINUTE;

const seen = new Map();

/** Open and recently merged PRs, at most one `gh` round per repo per minute. */
export async function prs(repoName, now = Date.now()) {
  const hit = seen.get(repoName);
  if (hit && now - hit.at < MINUTE) return hit;
  const list = async (state, fields, limit) =>
    JSON.parse(
      await gh([
        "pr",
        "list",
        "--repo",
        repoName,
        "--state",
        state,
        "--limit",
        String(limit),
        "--json",
        fields,
      ]),
    );
  const open = await list("open", FIELDS, 100);
  const merged = await list(
    "merged",
    "number,title,body,headRefName,files",
    30,
  );
  const out = { at: now, open, merged };
  seen.set(repoName, out);
  return out;
}

/**
 * What a PR carries: task stems — its branch is `todo/<stem>`, or it renames the task
 * file to `-DONE`/`-BLOCKED` — and issue numbers, from a `todo/NNN-…` branch or a
 * `Closes #NNN`. A `-TODO` file in its diff proves nothing: it may be a new task the PR
 * queues, which its merge must not retire.
 */
export function carried(pr, dir) {
  const stems = new Set();
  const issues = new Set();
  const branch = /^todo\/((\d+)-.+)$/.exec(pr.headRefName ?? "");
  if (branch) {
    stems.add(branch[1]);
    issues.add(String(Number(branch[2])));
  }
  for (const f of pr.files ?? [])
    if (dirname(f.path) === dir && /-(DONE|BLOCKED)\.md$/i.test(f.path))
      stems.add(stemOf(basename(f.path)));
  const text = `${pr.title ?? ""}\n${pr.body ?? ""}`;
  for (const m of text.matchAll(
    /\b(?:close[sd]?|fix(?:e[sd])?|resolve[sd]?)\s+#(\d+)\b/gi,
  ))
    issues.add(String(Number(m[1])));
  return { stems, issues };
}

/**
 * The PR among `list` that carries `task`, if any. A number only counts when the task
 * file names that issue itself: CI's failure files take the next free number, which a
 * later, unrelated issue can share.
 */
export function prOf(task, list, dir, handed = null) {
  return list.find((pr) => {
    if (pr.number === handed) return true;
    const { stems, issues } = carried(pr, dir);
    return (
      stems.has(task.stem) ||
      (task.issue != null && issues.has(String(Number(task.issue))))
    );
  });
}

/** Commit one file under the task folder and push it; false when another runner won. */
async function fileTask(repoPath, dir, name, body, message) {
  const rel = join(dir, name);
  writeFileSync(join(repoPath, rel), body);
  await git(["add", "--", rel], repoPath);
  await git(["commit", "-m", message, "--", rel], repoPath);
  return pushOrDrop(repoPath);
}

/** Push HEAD; on a lost race drop our one commit and let the next pull bring theirs. */
async function pushOrDrop(repoPath) {
  try {
    await git(["push", "origin", "HEAD"], repoPath);
    return true;
  } catch {
    await git(["reset", "--hard", "HEAD~1"], repoPath);
    return false;
  }
}

/**
 * A merged PR whose task is still `-TODO` on the base branch: the session never renamed
 * it, so rename it here. `pending` is the unfiltered queue. Returns log lines.
 */
export async function finishMerged({
  repoPath,
  dir,
  pending,
  merged,
  handedTo,
}) {
  const out = [];
  for (const task of pending) {
    const pr = prOf(task, merged, dir, handedTo(task.stem));
    if (!pr) continue;
    const done = await autoFinish(repoPath, dir, task.name, {
      note: `Finished in pull request #${pr.number}, which has merged; the runner renamed the file.`,
      message: `docs(todo): finish ${task.stem} — #${pr.number} merged (runner)`,
    });
    out.push(
      (await pushOrDrop(repoPath))
        ? `${done} — #${pr.number} merged`
        : `${task.name} — another runner finished it first`,
    );
  }
  return out;
}

/** The leading number after every one in use, as CI's own filer picks it. */
export function nextNumber(names) {
  const used = names.map((n) => Number(/^(\d+)-/.exec(n)?.[1] ?? 0));
  return String(Math.max(0, ...used) + 1).padStart(3, "0");
}

/** A `codeReview` task naming PR #n, in any state — a finished review is not redone. */
export function reviewed(full, names, n) {
  const ref = new RegExp(
    `(?:\\bPR\\s*#|pull request #|/pull/|gh pr ready )${n}\\b`,
    "i",
  );
  return names.some(
    (name) =>
      /codeReview/i.test(name) &&
      ref.test(readFileSync(join(full, name), "utf8")),
  );
}

/** Each check's latest run: all passed → when the last finished; else null. */
export function greenSince(pr) {
  const latest = new Map();
  for (const c of pr.statusCheckRollup ?? []) {
    const name = c.name ?? c.context;
    const at = Date.parse(c.completedAt ?? c.startedAt ?? 0) || 0;
    if ((latest.get(name)?.at ?? -1) <= at)
      latest.set(name, { at, ok: c.conclusion ?? c.state, status: c.status });
  }
  const checks = [...latest.values()];
  const passed = (c) =>
    (c.status ?? "COMPLETED") === "COMPLETED" &&
    ["SUCCESS", "SKIPPED", "NEUTRAL"].includes(c.ok);
  if (!checks.length || !checks.every(passed)) return null;
  return Math.max(...checks.map((c) => c.at));
}

const reviewTask = (pr, base) => `> Run with: Opus 5.5 / high

# Code review of pull request #${pr.number}

## Original Requirement

[NEVER REMOVE]

Pull request #${pr.number} ("${pr.title}", branch \`${pr.headRefName}\`) is a draft with no review
task, and a draft never merges by itself — the runner filed this one. ${pr.url}

Review PR #${pr.number}: \`git fetch origin ${pr.headRefName} && git switch ${pr.headRefName}\`, then run
\`/code-review high\` on \`origin/${base}...HEAD\`. Fix the confirmed findings on that branch with tests
and push. Summarize the review as a PR comment (\`gh pr comment ${pr.number}\`: findings, what was fixed,
what was not and why), then \`gh pr ready ${pr.number}\` — CI gates it again and merges it. Done means
merged.
`;

const stuckTask = (pr, since) => `> Run with: Sonnet 5 / medium

# Pull request #${pr.number} is green but not merged

## Original Requirement

[NEVER REMOVE]

Pull request #${pr.number} ("${pr.title}", branch \`${pr.headRefName}\`) is ready and passed every
check by ${new Date(since).toISOString()}, but it is still open more than 30 minutes later: the
merge job did not merge it. ${pr.url}

Find out why — \`gh pr view ${pr.number} --json mergeable,mergeStateStatus,labels,isDraft\` and the
merge job's log in the PR's latest run (\`gh run list --branch ${pr.headRefName} -L 3\`) — and fix the
cause, so the PR merges. Done means merged.
`;

/**
 * File a review task for each draft past its grace period that has none, and a task for
 * each green, ready PR the merge job left open. Only `todo/*` and `claude/*` branches —
 * a person's own PR is theirs to drive. Returns log lines.
 */
export async function sweepPrs({
  repoPath,
  dir,
  base,
  open,
  now = Date.now(),
}) {
  const full = join(repoPath, dir);
  const out = [];
  for (const pr of open) {
    if (!/^(todo|claude)\//.test(pr.headRefName)) continue;
    const names = readdirSync(full);
    let file = null;
    if (pr.isDraft) {
      const age = now - Date.parse(pr.createdAt);
      if (age > DRAFT_GRACE_MS && !reviewed(full, names, pr.number))
        file = [
          `codeReviewPr${pr.number}`,
          reviewTask(pr, base),
          "has no review task",
        ];
    } else if (!pr.labels?.some((l) => l.name === "hold")) {
      const since = greenSince(pr);
      const pending = new RegExp(
        `-(?:mergeStuck|gateFailure)Pr${pr.number}-TODO\\.md$`,
      );
      if (
        since &&
        now - since > STUCK_MS &&
        !names.some((n) => pending.test(n))
      )
        file = [
          `mergeStuckPr${pr.number}`,
          stuckTask(pr, since),
          "is green but not merged",
        ];
    }
    if (!file) continue;
    const [slug, body, why] = file;
    const name = `${nextNumber(names)}-${slug}-TODO.md`;
    const filed = await fileTask(
      repoPath,
      dir,
      name,
      body,
      `docs(todo): file ${name} — PR #${pr.number} ${why} (runner)`,
    );
    out.push(
      filed ? `filed ${name}` : `${name} — another runner filed it first`,
    );
  }
  return out;
}

const landed = new Map();

/**
 * `> After: #78` holds a task until #78 is a merged PR or a closed issue — a session
 * starts from the base branch and cannot see work that has not landed there.
 */
export async function waiting(repoName, task, now = Date.now()) {
  for (const n of task.after ?? []) {
    const key = `${repoName}#${n}`;
    const hit = landed.get(key);
    if (hit === true) continue;
    if (hit && now - hit < MINUTE) return n;
    const issue = JSON.parse(
      await gh(["api", `repos/${repoName}/issues/${n}`]),
    );
    const done = issue.pull_request
      ? Boolean(issue.pull_request.merged_at)
      : issue.state === "closed";
    landed.set(key, done || now);
    if (!done) return n;
  }
  return null;
}
