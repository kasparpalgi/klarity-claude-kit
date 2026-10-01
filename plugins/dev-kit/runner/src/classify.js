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
      5.5: "claude-opus-5-5",
    },
  },
  sonnet: {
    name: "Sonnet",
    effort: "medium",
    latest: "5",
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

/** Cheapest to priciest; fable is never auto-picked, so it never appears here. */
const FAMILY_ORDER = ["haiku", "sonnet", "opus"];

/**
 * One notch cheaper: drop effort first, then family. `null` once already at
 * haiku/low — that's the runner's signal to stop trying and wait for reset.
 * Gemini is not on the Claude usage budget, so it never steps down.
 */
export function downgrade(current) {
  if (current.engine) return null;
  const family = Object.entries(FAMILIES).find(([, f]) =>
    Object.values(f.versions).includes(current.model),
  )?.[0];
  const effortIdx = EFFORTS.indexOf(current.effort);
  if (effortIdx > 0) {
    const effort = EFFORTS[effortIdx - 1];
    return {
      model: current.model,
      effort,
      label: `${FAMILIES[family].name} / ${effort}`,
    };
  }

  const famIdx = FAMILY_ORDER.indexOf(family);
  if (famIdx <= 0) return null;
  return tier(FAMILY_ORDER[famIdx - 1]);
}

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
const NAMED =
  /run with:[ \t]*(fable|opus|sonnet|haiku|gemini)[ \t]*(\d+(?:\.\d+)?)?[ \t]*(?:\/[ \t]*(\w+))?/i;

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
