/**
 * Per-session Claude token usage (#21 step 1). A run's text stream never mentions
 * tokens, but Claude Code writes every session to
 * `~/.claude/projects/<cwd-slug>/<session-id>.jsonl`. Reading that *after* the run
 * covers both the headless and the herdr-pane path and leaves the live stream
 * untouched — `usage.js` still needs it verbatim.
 */

import { readFileSync, readdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join } from "node:path";
import { gql } from "./kanban.js";

const PROJECTS = join(homedir(), ".claude", "projects");
const M = 1_000_000;
const round6 = (n) => Math.round(n * 1e6) / 1e6;

/** Claude Code's transcript folder name: every non-alphanumeric becomes a dash. */
export const slugFor = (path) => path.replace(/[^a-zA-Z0-9]/g, "-");

export const projectDir = (repoPath, root = PROJECTS) =>
  join(root, slugFor(repoPath));

/**
 * The transcript a run just wrote. A fresh `claude -p` always creates a new file,
 * so a birthtime inside the run is the strong signal and survives a second
 * session running in the same repo; mtime is the fallback for a resumed one.
 */
export function findSessionFile(dir, sinceMs) {
  let names;
  try {
    names = readdirSync(dir).filter((n) => n.endsWith(".jsonl"));
  } catch {
    return null;
  }
  const touched = names
    .map((n) => ({ n, s: statSync(join(dir, n)) }))
    .filter((f) => f.s.mtimeMs >= sinceMs);
  const born = touched.filter((f) => f.s.birthtimeMs >= sinceMs);
  const [pick] = (born.length ? born : touched).sort(
    (a, b) => b.s.mtimeMs - a.s.mtimeMs,
  );
  return pick ? join(dir, pick.n) : null;
}

/**
 * Sum a transcript's assistant usage, grouped by model. One reply repeats its
 * `message.usage` once per content block (three identical lines is normal), so
 * rows dedupe on `message.id` — summing blindly doubles the bill. Sidechain
 * (subagent) turns are kept: they are billed like any other.
 */
export function sumUsage(lines) {
  const byModel = {};
  const seen = new Set();
  let startedAt = null;
  let endedAt = null;
  for (const line of lines) {
    let e;
    try {
      e = JSON.parse(line);
    } catch {
      continue;
    }
    if (e.timestamp) {
      if (!startedAt || e.timestamp < startedAt) startedAt = e.timestamp;
      if (!endedAt || e.timestamp > endedAt) endedAt = e.timestamp;
    }
    const msg = e.type === "assistant" ? e.message : null;
    const u = msg?.usage;
    if (!u) continue;
    const key = msg.id ?? e.requestId;
    if (key) {
      if (seen.has(key)) continue;
      seen.add(key);
    }
    const t = (byModel[msg.model ?? "unknown"] ??= {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
    });
    t.input += u.input_tokens ?? 0;
    t.output += u.output_tokens ?? 0;
    t.cacheRead += u.cache_read_input_tokens ?? 0;
    t.cacheWrite += u.cache_creation_input_tokens ?? 0;
  }
  return { byModel, startedAt, endedAt };
}

/** Price row for a model id, tolerating a dated variant (`…-20250929`). */
const priceOf = (pricing, model) =>
  pricing[model] ?? pricing[model.replace(/-\d{8}$/, "")] ?? null;

/**
 * API-list cost of a per-model breakdown, plus the model that dominated it. An
 * unpriced model costs 0 and is named in `missing` — LiteLLM lags a brand-new
 * id by days and that must never crash a run's bookkeeping.
 */
export function costOf(byModel, pricing) {
  const missing = [];
  let costUsd = 0;
  let model = null;
  let best = [-1, -1];
  for (const [name, t] of Object.entries(byModel)) {
    const p = priceOf(pricing, name);
    if (!p) missing.push(name);
    const c = p
      ? (t.input * p.input_per_mtok +
          t.output * p.output_per_mtok +
          t.cacheRead * p.cache_read_per_mtok +
          t.cacheWrite * p.cache_write_per_mtok) / M
      : 0;
    costUsd += c;
    // Dominant = the priciest slice; unpriced models all tie at 0, so output
    // tokens break the tie and the row still names whoever did the work.
    if (c > best[0] || (c === best[0] && t.output > best[1])) {
      best = [c, t.output];
      model = name;
    }
  }
  return { costUsd: round6(costUsd), model, missing };
}

/** Flatten a per-model breakdown into one set of totals. */
const KINDS = ["input", "output", "cacheRead", "cacheWrite"];
export const totalsOf = (byModel) =>
  Object.values(byModel).reduce(
    (a, t) => Object.fromEntries(KINDS.map((k) => [k, a[k] + t[k]])),
    Object.fromEntries(KINDS.map((k) => [k, 0])),
  );

const PRICING = `query P { claude_model_pricing { model input_per_mtok
  output_per_mtok cache_read_per_mtok cache_write_per_mtok } }`;

// Same `github`-is-text dance as kanban.js: `_contains` is a runtime error there.
const OWNER = `query O($repo: String!) {
  boards(where: {github: {_ilike: $repo}}, limit: 1) { user_id }
}`;

// Idempotent on session_id: a re-run is a *new* session (new row); re-ingesting
// the same transcript only refreshes it.
const UPSERT = `mutation U($row: claude_usage_insert_input!) {
  insert_claude_usage_one(object: $row, on_conflict: {
    constraint: claude_usage_session_id_key
    update_columns: [todo_id user_id repo model input_tokens output_tokens
      cache_read_tokens cache_write_tokens usage_by_model cost_usd
      started_at ended_at]
  }) { id }
}`;

/**
 * Record one `claude_usage` row for the session a run just finished. Returns a
 * log line, or null when the Kanban is not configured. A missing transcript,
 * unpriced model or unknown repo is a log line, never a throw: bookkeeping must
 * not be able to fail a task that otherwise went fine.
 */
export async function recordUsage(
  kanban,
  { repoName, repoPath, todoId = null, sinceMs, dir = projectDir(repoPath) },
  gqlFn = gql,
) {
  if (!kanban?.endpoint || !kanban?.adminSecret) return null;
  const file = findSessionFile(dir, sinceMs);
  if (!file) return "usage: no session transcript for this run";
  const sessionId = basename(file, ".jsonl");
  const { byModel, startedAt, endedAt } = sumUsage(
    readFileSync(file, "utf8").split("\n"),
  );
  if (!Object.keys(byModel).length)
    return `usage: ${sessionId} has no assistant turns`;

  const [{ claude_model_pricing: prices }, { boards }] = await Promise.all([
    gqlFn(kanban, PRICING, {}),
    gqlFn(kanban, OWNER, { repo: `%${repoName}%` }),
  ]);
  const userId = boards?.[0]?.user_id;
  if (!userId) return `usage: no board owner for ${repoName} — not recorded`;

  const pricing = Object.fromEntries(prices.map((r) => [r.model, r]));
  const { costUsd, model, missing } = costOf(byModel, pricing);
  const t = totalsOf(byModel);
  const row = {
    session_id: sessionId,
    todo_id: todoId,
    user_id: userId,
    repo: repoName,
    model,
    input_tokens: t.input,
    output_tokens: t.output,
    cache_read_tokens: t.cacheRead,
    cache_write_tokens: t.cacheWrite,
    usage_by_model: byModel,
    cost_usd: costUsd,
    started_at: startedAt,
    ended_at: endedAt,
  };
  await gqlFn(kanban, UPSERT, { row });
  const read = t.input + t.cacheRead + t.cacheWrite;
  const warn = missing.length ? ` (no price for ${missing.join(", ")})` : "";
  return `usage: ${model} ${read} in / ${t.output} out → $${costUsd.toFixed(4)}${warn}`;
}
