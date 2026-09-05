# kanban-runner

A personal daemon that watches local git clones for new `doc/todo/NNN-*-TODO.md` files
and runs `/todo NNN` against them via `claude`. No Hasura, no admin secret, no public
endpoint.

```
git pull --ff-only  (each configured repo)
    │  find NNN-*-TODO.md with no matching NNN-*-DONE.md
    │  claude -p "/todo NNN" --model … --effort …
    ▼
/todo renames to NNN-*-DONE.md  →  git push origin main
```

The `-DONE.md` rename **is** the state. No database, no marker files — restart is safe.

> **Personal opt-in tooling, not the product.** A user who never installs this loses
> nothing. The product path is task-014 (server writes the file) + task-016 (push webhook).

## Setup for a new project

1. **Connect your board.** On todzz.eu, connect the board to a GitHub repo and set the
   "agent list" (the column that means "ready for Claude"). Task-014 makes the server
   write a `NNN-slug-TODO.md` file to the repo when a card enters that list.

2. **Clone the repo locally.** The runner watches local clones.

3. **Add the repo to `config.json`:**

   ```json
   {
     "pollSeconds": 20,
     "repos": {
       "owner/repo": "~/Documents/GitHub/my-project"
     }
   }
   ```

4. **Install the dev-kit plugin** (once per machine):

   ```bash
   claude plugin marketplace add kaspar-palgi/klarity-claude-kit
   claude plugin install dev-kit@klarity
   ```

   This gives the repo `/todo`, `/plan`, and `/verify` skills.

5. **Make sure the repo has a task folder.** Either `doc/todo/` or `.claude/todo/` — the
   runner checks `.claude/todo` first, falls back to `doc/todo`.

6. **Start the runner.** See below for headless or visible mode.

## Headless mode (launchd)

Runs in the background, unattended. Claude uses `--dangerously-skip-permissions` — it
never asks questions and never stops to wait.

```bash
cd plugins/dev-kit/runner
cp config.example.json config.json     # edit the repo map
npm run check                          # prints repos + any pending TODO files
npm start                              # foreground test

# Auto-start on macOS:
cp launchd.plist.example ~/Library/LaunchAgents/eu.todzz.kanban-runner.plist
# Edit: PATH (must include ~/.local/bin for claude), WorkingDirectory
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/eu.todzz.kanban-runner.plist
tail -f ~/Library/Logs/kanban-runner.log
```

**Important:** the launchd PATH must include `~/.local/bin` (where `claude` lives):

```xml
<string>/Users/YOU/.local/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin</string>
```

## Visible mode (tmux + herdr)

See Claude working in real time. Get a notification (ding!) when Claude needs input.

```bash
# 1. Start in a tmux session
tmux new-session -d -s runner "node plugins/dev-kit/runner/src/run.js --interactive"

# 2. Watch with herdr for notifications
herdr watch -s runner

# 3. Attach when you want to see what's happening
tmux attach -t runner
```

With `--interactive`:
- Claude runs WITHOUT `--dangerously-skip-permissions`
- Claude can ask permission questions → herdr dings you
- You can see the full streaming output in the tmux pane
- stdin is inherited so you can type answers if attached

Without `--interactive` (default):
- Claude runs headless, never asks
- Suitable for launchd / unattended use

## How it works

Each tick (one per `pollSeconds`):

1. For each configured repo, check for a dirty working tree → skip if dirty (never forced).
2. `git pull --ff-only` → skip the repo if the branch has diverged.
3. Find the task folder (`.claude/todo` if it exists, else `doc/todo`).
4. Find the lowest `NNN-*-TODO.md` where no `NNN-*-DONE.md` exists.
5. Read the `> Run with:` frontmatter line (written by task-014). Classify with a
   cheap Claude call if the line is missing; default to `Sonnet 5 / medium` on failure.
6. Run `claude -p "/todo NNN" --model … --effort …`.
7. Save the full session output next to the task file as `NNN-slug.log`, and push the
   last 15 lines to the phone (success and failure alike).
8. If HEAD advanced (i.e. `/todo` committed), push to `origin main`.

Logs are gitignored: the first run in a repo commits `*.log` to the task folder's
`.gitignore`, so transcripts never dirty the tree or reach the remote.

**One task per tick.** The loop returns after the first task it runs, so repos queue
naturally.

## Config

`config.json` is gitignored.

| Key           | Meaning                                                       |
| ------------- | ------------------------------------------------------------- |
| `pollSeconds` | how often to pull (default 60)                                |
| `repos`       | `"owner/repo"` → local clone path; `~/` is expanded at runtime |

## Model & effort

The task file's first line decides: `> Run with: Fable 5 / high`, `Opus 5 / high`,
`Sonnet 5 / medium`, or `Haiku 4.5 / low`. Otherwise a haiku classifier call picks the
tier. See `classify.js`.

## CLI flags

| Flag            | Effect                                              |
| --------------- | --------------------------------------------------- |
| `--check`       | Print each repo path + any pending task file; run nothing |
| `--interactive` | Drop `--dangerously-skip-permissions`; inherit stdin |

## Notes

- Requires Node ≥ 20 and `claude` on `PATH`. No npm dependencies.
- A repo whose `CLAUDE.md` forbids committing will complete the task but leave HEAD
  unchanged — the log says so and no push is attempted.
