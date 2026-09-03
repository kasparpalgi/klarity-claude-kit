# klarity-claude-kit

Shared Claude Code plugin marketplace for Klarity projects.
Contains the `dev-kit` plugin: `/todo`, `/plan`, `/verify`, and the `research-first` skill.

## Install (once per machine)

```bash
# From GitHub (recommended — all machines stay in sync)
claude plugin marketplace add kaspar-palgi/klarity-claude-kit
claude plugin install dev-kit@klarity

# From a local clone (development / offline)
claude plugin marketplace add ~/Documents/GitHub/klarity-claude-kit
claude plugin install dev-kit@klarity
```

## Update everywhere

Edit the skills in `plugins/dev-kit/`, bump `version` in `plugins/dev-kit/.claude-plugin/plugin.json`, push.
Other projects pick it up on `/plugin` update — no per-repo copies to keep in sync.

## Skills

| Skill             | Invoked   | Purpose                                              |
| ----------------- | --------- | ---------------------------------------------------- |
| `/todo <n>`       | by you    | Run a numbered task from `doc/todo/`                 |
| `/plan <request>` | by you    | Write a new numbered task file, don't build          |
| `/verify`         | by you    | Run the project's verification chain                 |
| `research-first`  | by Claude | Look up docs before coding against an unfamiliar API |

## Runner

`plugins/dev-kit/runner/` watches a Kanban board and runs `/todo` automatically.
Move a card to **TODO** → it writes the task file and executes it in the matching repo.
Start it yourself; it is not loaded by Claude Code.

## Local development

```bash
claude --plugin-dir ./plugins/dev-kit    # load without installing
/reload-plugins                          # after edits
claude plugin validate ./plugins/dev-kit
```
