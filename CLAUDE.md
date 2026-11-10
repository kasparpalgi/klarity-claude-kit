## Project Configuration

### About Project

The `klarity` Claude Code marketplace and its one plugin, `dev-kit`: the `/plan` → `/todo` →
`/verify` workflow every Klarity repo runs, and the Kanban runner that turns a card on
todzz.eu into a `/todo` run on one of our machines.

IMPORTANT: develop in the main branch. Commit and push changes when the task is done. For any other tasks do not ask for permissions.

- **Language**: JavaScript (Node ≥ 20, ES modules, zero dependencies) + Markdown skills
- **Package Manager**: npm (runner only — there is no root `package.json`)

---

## How work happens here

Every request becomes **one markdown file in `doc/todo/`** holding the original prompt at
the top and the outcome at the bottom. That folder is the prompt history — never rewrite
the top of a file.

| Step                                  | Command            |
| ------------------------------------- | ------------------ |
| Turn a request into a task file       | `/plan <request>`  |
| Execute a task file                   | `/todo <number>`   |
| Check a change                        | `/verify`          |
| Audit auth / secrets / input handling | `/security-review` |

These come from the `dev-kit` plugin — this repo — enabled in `.claude/settings.json`.
A session runs the **installed** copy, not this working tree. To try an edited skill:
`claude --plugin-dir ./plugins/dev-kit`, then `/reload-plugins` after each edit.

Tasks before #92 were filed on the boilerplate board, so older commits cite
`svelte-hasura-boilerplate#N`. A task filed here ends its commit subject with `(#N)`.

---

## Layout

```
.claude-plugin/marketplace.json     # the `klarity` marketplace
plugins/dev-kit/
├── .claude-plugin/plugin.json      # plugin version
├── skills/<name>/SKILL.md          # todo, plan, verify, cross-review, debug, research-first
├── hooks/hooks.json  .mcp.json     # prettier after edits, Exa search MCP
└── runner/                         # the Kanban daemon — runner/README.md is its manual
    ├── src/  test/                 # one module per concern, node:test
    └── config.json                 # per machine, gitignored, holds the Hasura admin secret
```

---

## Rules

- **Version bump**: a skill, hook or MCP change bumps `plugins/dev-kit/.claude-plugin/plugin.json`;
  a runner change bumps `plugins/dev-kit/runner/package.json`. PATCH for fixes, MINOR for features.
- **The runner runs from this checkout** on every machine. A push to `main` restarts it on
  its next tick (`src/selfUpdate.js`), so a broken `src/` stops every repo's queue at once.
  `npm test` passes before every push.
- **Secrets**: never print, copy or commit `runner/config.json`. Document a new config key
  in `config.example.json` instead.
- **Docs ride with the code**: a runner behaviour change updates `runner/README.md` in the
  same commit; a new or renamed skill updates the tables in `README.md` and `plugins/dev-kit/README.md`.
- **Skills are prompts other agents read in other repos**: no paths or names that exist
  only here, and keep them short — every line costs every run.
- Keep files ~100 lines, max 200. Simplicity is GENIUS.

---

## Verify

```bash
cd plugins/dev-kit/runner && npm test        # node:test over test/*.test.js
claude plugin validate ./plugins/dev-kit     # manifest, skills, hooks
```
