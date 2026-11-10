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
    latest: "5.5",
    versions: {
      4.6: "claude-opus-4-6",
      4.8: "claude-opus-4-8",
      5: "claude-opus-5",
      5.5: "claude-opus-5-5",
    },
  },
  sonnet: {
    name: "Sonnet",
    effort: "medium",
    latest: "5.5",
    versions: {
      4.6: "claude-sonnet-4-6",
      5: "claude-sonnet-5",
      5.5: "claude-sonnet-5-5",
    },
  },
  haiku: {
    name: "Haiku",
    effort: "low",
    latest: "4.5",
    versions: { 4.5: "claude-haiku-4-5" },
  },
  // Free, and not Claude: runs through aider (src/aider.js), not `claude`. Gemini
  // 3.8 Flash takes only low/medium/high thinking, so `efforts` caps xhigh/max.
  gemini: {
    name: "Gemini",
    effort: "medium",
    latest: "3.8",
    versions: { 3.8: "gemini/gemini-3.8-flash" },
    efforts: ["low", "medium", "high"],
    engine: "aider",
  },
};

const EFFORTS = ["low", "medium", "high", "xhigh", "max"];

/** `tier("sonnet", "4.6", "low")` -> `claude-sonnet-4-6` / low / "Sonnet 4.6 / low". */
function tier(family, version, effort) {
  const f = FAMILIES[family];
  if (!f) return null;
  const v = f.versions[version] ? version : f.latest;
  const allowed = f.efforts ?? EFFORTS;
  let e = EFFORTS.includes(effort) ? effort : f.effort;
  if (!allowed.includes(e)) e = allowed.at(-1);
  const t = { model: f.versions[v], effort: e, label: `${f.name} ${v} / ${e}` };
  return f.engine ? { ...t, engine: f.engine } : t;
}

/**
 * The card may say it outright: "Run with: Opus 4.8 / xhigh", "Sonnet 4.6 / low",
 * or just "Run with: haiku". A version we do not know falls back to the family's
 * latest rather than failing the run; same for an effort outside EFFORTS.
 */
const TIER =
  /(fable|opus|sonnet|haiku|gemini)[ \t]*(\d+(?:\.\d+)?)?[ \t]*(?:\/[ \t]*(\w+))?/i;
const NAMED = new RegExp(`run with:[ \\t]*${TIER.source}`, "i");

const tierOf = (m) =>
  m ? tier(m[1].toLowerCase(), m[2], m[3]?.toLowerCase()) : null;

export const explicitTier = (text) => tierOf(NAMED.exec(text || ""));

/** A bare tier, as config.json's `classifier` names it: "Opus 5.5 / low". */
export const parseTier = (text) => tierOf(TIER.exec(text || ""));

/**
 * Otherwise ask a model which family and effort fit. Which model asks is
 * config.json's `classifier` (default Opus / low): the call is a few hundred
 * tokens, so the best judge costs next to nothing. Version stays the family's
 * latest. Fable is never auto-chosen: it bills usage credits, so it has to be
 * asked for by name.
 */
const PROMPT = `Classify this development task by how much model it needs.
Answer with exactly two words, family then effort, nothing else.
Family:
opus - hard architecture, multi-system design, security-sensitive work
sonnet - a normal feature, refactor or bugfix
haiku - a mechanical edit: rename, copy change, config tweak
Effort: low, medium, high, xhigh or max - how hard the model must think.

Task:
`;

/** The classifier's reply -> a tier; null when it named no family. */
export function readAnswer(stdout) {
  const m =
    /\b(opus|sonnet|haiku)\b(?:\W+(low|medium|high|xhigh|max)\b)?/i.exec(
      stdout || "",
    );
  return m ? tier(m[1].toLowerCase(), undefined, m[2]?.toLowerCase()) : null;
}

/** Falls back to sonnet on any trouble — the classifier is a nicety, not a gate. */
export async function classify(text, by = "Opus / low", exec = run) {
  const explicit = explicitTier(text);
  if (explicit) return explicit;

  // Gemini runs through aider, not `claude -p`, so it cannot be the judge.
  const named = parseTier(by);
  const judge = named && !named.engine ? named : parseTier("Opus / low");
  try {
    const { stdout } = await exec(
      "claude",
      ["-p", PROMPT + text, "--model", judge.model, "--effort", judge.effort],
      { timeout: 60_000 },
    );
    const picked = readAnswer(stdout);
    if (picked) return picked;
  } catch {
    // classifier is a nicety, never a blocker
  }
  return tier("sonnet");
}
