/** Decide which model + effort a card should run with. */

import { execFile } from "node:child_process";
import { promisify } from "node:util";

const run = promisify(execFile);

/**
 * Versions are pinned, never aliased. `--model sonnet` always means the *latest*
 * Sonnet, so a card asking for "Sonnet 4.6 / low" silently got Sonnet 5 — naming
 * the full model id is the only way to honour the version the card asked for.
 * Add a version by putting its id in `versions`; `latest` is what a bare family
 * name means. `effort` is the family's default when the card names none.
 */
const FAMILIES = {
  fable: {
    name: "Fable",
    effort: "high",
    latest: "5.1",
    versions: { 5.1: "claude-fable-5-1" },
  },
  opus: {
    name: "Opus",
    effort: "high",
    latest: "5",
    versions: {
      4.6: "claude-opus-4-6",
      4.8: "claude-opus-4-8",
      5: "claude-opus-5",
    },
  },
  sonnet: {
    name: "Sonnet",
    effort: "medium",
    latest: "5",
    versions: { 4.6: "claude-sonnet-4-6", 5: "claude-sonnet-5" },
  },
  haiku: {
    name: "Haiku",
    effort: "low",
    latest: "4.5",
    versions: { 4.5: "claude-haiku-4-5" },
  },
};

const EFFORTS = ["low", "medium", "high", "xhigh", "max"];

/** `tier("sonnet", "4.6", "low")` -> `claude-sonnet-4-6` / low / "Sonnet 4.6 / low". */
function tier(family, version, effort) {
  const f = FAMILIES[family];
  if (!f) return null;
  const v = f.versions[version] ? version : f.latest;
  const e = EFFORTS.includes(effort) ? effort : f.effort;
  return { model: f.versions[v], effort: e, label: `${f.name} ${v} / ${e}` };
}

/**
 * The card may say it outright: "Run with: Opus 4.8 / xhigh", "Sonnet 4.6 / low",
 * or just "Run with: haiku". A version we do not know falls back to the family's
 * latest rather than failing the run; same for an effort outside EFFORTS.
 */
const NAMED =
  /run with:[ \t]*(fable|opus|sonnet|haiku)[ \t]*(\d+(?:\.\d+)?)?[ \t]*(?:\/[ \t]*(\w+))?/i;

export function explicitTier(text) {
  const m = NAMED.exec(text || "");
  return m ? tier(m[1].toLowerCase(), m[2], m[3]?.toLowerCase()) : null;
}

/**
 * Otherwise ask the cheapest model which family fits. It picks a family only —
 * version and effort stay at that family's default. Fable is never auto-chosen:
 * it bills usage credits, so it has to be asked for by name.
 */
const PROMPT = `Classify this development task by how much model it needs.
Answer with exactly one word, nothing else:
opus - hard architecture, multi-system design, security-sensitive work
sonnet - a normal feature, refactor or bugfix
haiku - a mechanical edit: rename, copy change, config tweak

Task:
`;

/** Falls back to sonnet on any trouble — the classifier is a nicety, not a gate. */
export async function classify(text) {
  const explicit = explicitTier(text);
  if (explicit) return explicit;

  try {
    const { stdout } = await run(
      "claude",
      ["-p", PROMPT + text, "--model", "haiku"],
      { timeout: 60_000 },
    );
    const word = /\b(opus|sonnet|haiku)\b/i.exec(stdout);
    if (word) return tier(word[1].toLowerCase());
  } catch {
    // classifier is a nicety, never a blocker
  }
  return tier("sonnet");
}
