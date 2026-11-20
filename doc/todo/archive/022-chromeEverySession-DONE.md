> Run with: Opus 5.5 / high · done inline from ezysmart-web 074 (2026-11-19, Karel)

# Claude in Chrome in every runner session

## Original Requirement

[NEVER REMOVE]

rememeber to always use chrome skill and whatever else needed on the klarity-claude-kit so all repos I work
on can seamlessly use the browser once you are done

## Why

ezysmart-web 074 needed the Oracle Console in the Mac's Chrome. The runner session had no
`mcp__claude-in-chrome__*` tools: it started while the extension's login had expired, and a running
session never picks the browser up later. A fresh `claude -p --chrome` on the same machine saw the Mac's
Chrome at once and did the step.

## Results

**Summary**
- Runner: every session starts with `claude --chrome` (herdr and headless paths). Config key `chrome`,
  default `true`.
- `/todo` skill, step 3: a web-UI step is the agent's job in the user's Chrome. If the tools are missing,
  it runs the step in a fresh `claude -p --chrome` session before calling it a human step.

**Files changed**
- Modified: `plugins/dev-kit/runner/src/run.js`, `src/config.js`, `README.md`, `test/onboard.test.js`,
  `package.json` (0.39.0); `plugins/dev-kit/skills/todo/SKILL.md`, `.claude-plugin/plugin.json` (0.26.0)

**Verification**
- [x] `npm test` in `runner/`: 255/255 pass (new: the `chrome` default and opt-out).
- [x] `claude -p --chrome` on Karel lists the Mac's Chrome ("Browser 2", macOS) and drove the Oracle Console.

**Deviations** — None
