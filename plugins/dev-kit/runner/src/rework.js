/**
 * A person's review on a runner PR comes back as a task (svelte-hasura-boilerplate#71).
 * A `todo/*` PR with a "Request changes" review, or an unresolved thread a person wrote
 * in after the last push, gets `NNN-reworkPr<N>-TODO.md` — once per review round. The
 * session works on the PR's branch, pushes, and answers every thread with a reply
 * that carries `MARK`, so its own answers never read as new feedback.
 */

import { execFile } from "node:child_process";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { promisify } from "node:util";
import { carried, fileTask, nextNumber } from "./pr.js";
import { stemOf } from "./queue.js";

const run = promisify(execFile);

/** Hidden in the rendered reply; tells the sweep a thread is answered. */
export const MARK = "<!-- runner-reply -->";

const QUERY = `query($owner: String!, $name: String!) {
  repository(owner: $owner, name: $name) {
    pullRequests(states: OPEN, first: 50) {
      nodes {
        number title url headRefName
        files(first: 100) { nodes { path } }
        commits(last: 1) { nodes { commit { committedDate } } }
        latestReviews(first: 20) { nodes { author { __typename login } state submittedAt body url } }
        reviewThreads(first: 50) { nodes { id isResolved path line
          comments(last: 20) { nodes { author { __typename login } body createdAt url } } } }
      }
    }
  }
}`;

const seen = new Map();

/** Open PRs with their reviews and threads, at most one GraphQL round a minute. */
export async function feedback(repoName, now = Date.now()) {
  const hit = seen.get(repoName);
  if (hit && now - hit.at < 60_000) return hit.prs;
  const [owner, name] = repoName.split("/");
  const { stdout } = await run(
    "gh",
    [
      "api",
      "graphql",
      "-F",
      `owner=${owner}`,
      "-F",
      `name=${name}`,
      "-f",
      `query=${QUERY}`,
    ],
    { timeout: 60_000, maxBuffer: 1 << 26 },
  );
  const prs = JSON.parse(stdout).data.repository.pullRequests.nodes;
  seen.set(repoName, { at: now, prs });
  return prs;
}

const person = (a) => a && a.__typename !== "Bot" && !/\[bot\]$/.test(a.login);
const said = (c) => person(c.author) && !c.body.includes(MARK);

/**
 * What a person asked on `pr` that is still open: "Request changes" reviews, and
 * unresolved threads whose last word is a person's, after the last push. `round` is
 * the newest of those times (ISO), null when nothing is asked.
 */
export function asks(pr) {
  const pushed =
    Date.parse(pr.commits?.nodes?.[0]?.commit.committedDate ?? 0) || 0;
  const reviews = (pr.latestReviews?.nodes ?? []).filter(
    (r) => r.state === "CHANGES_REQUESTED" && said(r),
  );
  const threads = [];
  for (const t of pr.reviewThreads?.nodes ?? []) {
    if (t.isResolved) continue;
    const talk = t.comments.nodes.filter((c) => person(c.author));
    const last = talk.at(-1);
    if (last && said(last) && Date.parse(last.createdAt) > pushed)
      threads.push({ ...t, last });
  }
  const times = [
    ...reviews.map((r) => r.submittedAt),
    ...threads.map((t) => t.last.createdAt),
  ].sort();
  return { reviews, threads, round: times.at(-1) ?? null };
}

const quote = (s) => s.trim().replace(/\s+/g, " ").slice(0, 400) || "(no text)";

export const reworkTask = (
  pr,
  { reviews, threads, round },
) => `> Run with: Opus 5.5 / high

# Rework pull request #${pr.number} after review

## Original Requirement

[NEVER REMOVE]

Pull request #${pr.number} ("${pr.title}", branch \`${pr.headRefName}\`) has review feedback as of
${round} that nobody has answered — the runner filed this one. ${pr.url}

${[
  ...reviews.map(
    (r) =>
      `- Review by ${r.author.login} — changes requested: ${quote(r.body)} (${r.url})`,
  ),
  ...threads.map(
    (t) =>
      `- \`${t.path}${t.line ? `:${t.line}` : ""}\` — ${t.last.author.login}: ${quote(t.last.body)} (thread \`${t.id}\`, ${t.last.url})`,
  ),
].join("\n")}

Work on the PR's branch: \`git fetch origin ${pr.headRefName} && git switch ${pr.headRefName}\`. Read each
thread in full (\`gh pr view ${pr.number} --comments\` and the links above). Every point is either fixed, with a
test where it fits, or answered with a reasoned pushback — none is skipped. Push to that same branch.

Then answer **every thread** above, starting each reply with \`${MARK}\` so the runner knows it is answered:
\`gh api graphql -f query='mutation($id: ID!, $body: String!) { addPullRequestReviewThreadReply(input: {pullRequestReviewThreadId: $id, body: $body}) { comment { url } } }' -f id=<thread> -f body='${MARK} Fixed in <sha>: …'\`.
Answer a review's own text with \`gh pr comment ${pr.number} --body '${MARK} …'\` and ask its author to look
again (\`gh pr edit ${pr.number} --add-reviewer <login>\`). Leave resolving threads to the reviewer. Done means
merged.
`;

/**
 * File a rework task for each `todo/*` PR with open feedback, once per round: none
 * while one for that PR is still to run (a `-TODO` its PR neither finishes nor was
 * handed), and none again for a round a task already named. Returns log lines.
 */
export async function sweepRework({
  repoPath,
  dir,
  prs,
  handedTo = () => null,
}) {
  const full = join(repoPath, dir);
  const out = [];
  for (const pr of prs) {
    if (!/^todo\//.test(pr.headRefName)) continue;
    const ask = asks(pr);
    if (!ask.round) continue;
    const { stems } = carried({ ...pr, files: pr.files?.nodes }, dir);
    const names = readdirSync(full);
    const mine = new RegExp(`-reworkPr${pr.number}-`);
    const filed = (n) =>
      mine.test(n) &&
      ((/-TODO\.md$/.test(n) &&
        !stems.has(stemOf(n)) &&
        handedTo(stemOf(n)) !== pr.number) ||
        readFileSync(join(full, n), "utf8").includes(ask.round));
    if (names.some(filed)) continue;
    const name = `${nextNumber(names)}-reworkPr${pr.number}-TODO.md`;
    const ok = await fileTask(
      repoPath,
      dir,
      name,
      reworkTask(pr, ask),
      `docs(todo): file ${name} — PR #${pr.number} has review feedback (runner)`,
    );
    out.push(ok ? `filed ${name}` : `${name} — another runner filed it first`);
  }
  return out;
}
