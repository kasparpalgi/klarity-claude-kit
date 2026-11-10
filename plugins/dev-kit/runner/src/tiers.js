/**
 * How each model + effort tier actually does, from the `claude_usage` rows the
 * runner already records (sessionUsage.js). It answers "is Opus worth it over
 * Sonnet?" with numbers: a tier that needs more sessions per card is retrying,
 * and minutes, output tokens and cost show what a card costs at that tier.
 */

const median = (xs) => {
  if (!xs.length) return 0;
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};

/** `claude-opus-5-5-20260101` -> `opus-5-5`. */
const short = (model) =>
  (model ?? "unknown").replace(/^claude-/, "").replace(/-\d{8}$/, "");

/** Rows -> one line per tier, most-used first. Effort comes from the card; "auto" when unset. */
export function tierReport(rows) {
  const groups = new Map();
  for (const r of rows) {
    if (r.model?.startsWith("<")) continue; // `<synthetic>`: an API error, not a run
    const key = `${short(r.model)} / ${r.todo?.agent_effort ?? "auto"}`;
    const g = groups.get(key) ?? { tier: key, cards: new Set(), runs: [] };
    if (r.todo_id) g.cards.add(r.todo_id);
    g.runs.push(r);
    groups.set(key, g);
  }
  return [...groups.values()]
    .map(({ tier, cards, runs }) => ({
      tier,
      sessions: runs.length,
      cards: cards.size,
      perCard: cards.size ? +(runs.length / cards.size).toFixed(2) : null,
      minutes: +median(
        runs
          .filter((r) => r.started_at && r.ended_at)
          .map(
            (r) => (Date.parse(r.ended_at) - Date.parse(r.started_at)) / 6e4,
          ),
      ).toFixed(1),
      outTokens: Math.round(median(runs.map((r) => r.output_tokens ?? 0))),
      costUsd: +runs.reduce((a, r) => a + (+r.cost_usd || 0), 0).toFixed(2),
    }))
    .sort((a, b) => b.sessions - a.sessions);
}
