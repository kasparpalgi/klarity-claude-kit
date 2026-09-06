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

## Visible mode (herdr) — recommended

Set `"useHerdr": true` and the runner stops spawning `claude` as a bare child of the
launchd daemon. Instead it opens a herdr tab and starts the agent inside it:

```
tab create --workspace <ws> --cwd <repo> --label task-NNN --no-focus
agent start task-NNN --kind claude --pane <pane> -- --model … --permission-mode acceptEdits
agent prompt task-NNN "/todo NNN" --wait
```

Because the agent lives in a herdr pane it is inventoried by the herdr server, so it
shows up in `herdr agent list` and on the phone at `https://herdr.servicehost.io`
while it works. A bare child process is invisible to both.

Permissions use `--permission-mode acceptEdits`: file edits — the bulk of a `/todo`
run — flow without prompting, while Bash and destructive operations still ask. An
asking agent settles to `blocked`, which sends a Pushbullet **"Runner ⏸ needs you"**
with the pane text; answer it in the relay PWA and the run continues. Set
`"unattended": true` to go back to `--dangerously-skip-permissions` for overnight runs
nobody will be watching.

Safety rails:

- herdr server down or `useHerdr` false → falls back to the headless child, logged as
  `herdr down — falling back to headless`. It never wedges on herdr's absence.
- A block nobody answers within `blockedMinutes` closes the tab and leaves the task
  file as `-TODO`, so the queue advances.
- Any surviving `task-*` agent is a leak from a crashed run and is reaped at the start
  of the next one.

### Legacy: tmux + `--interactive`

`--interactive` predates the herdr path: it drops `--dangerously-skip-permissions` and
inherits stdin, so it only works when you attach a terminal yourself. Prefer
`useHerdr`.

## How it works

Each tick (one per `pollSeconds`):

1. For each configured repo, check for a dirty working tree → skip if dirty (never forced).
2. `git pull --ff-only` → skip the repo if the branch has diverged.
3. Find the task folder (`.claude/todo` if it exists, else `doc/todo`).
4. Find the lowest `NNN-*-TODO.md` where no `NNN-*-DONE.md` exists.
5. Read the `> Run with:` frontmatter line (written by task-014). Classify with a
   cheap Claude call if the line is missing; default to `Sonnet 5 / medium` on failure.
6. Run `/todo NNN` — in a herdr tab when `useHerdr` is on, otherwise as
   `claude -p "/todo NNN" --model … --effort …`.
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
| `pollSeconds`    | how often to pull (default 60)                                 |
| `repos`          | `"owner/repo"` → local clone path; `~/` is expanded at runtime  |
| `useHerdr`       | run Claude in a herdr pane, visible on the phone (default false) |
| `unattended`     | on the herdr path, skip permissions instead of asking (false)   |
| `taskMinutes`    | cap on one `/todo` run (default 45)                             |
| `blockedMinutes` | how long to wait for a human to answer a prompt (default 30)    |

## Model & effort

The task file's first line decides: `> Run with: Fable 5 / high`, `Opus 5 / high`,
`Sonnet 5 / medium`, or `Haiku 4.5 / low`. Otherwise a haiku classifier call picks the
tier. See `classify.js`.

## CLI flags

| Flag            | Effect                                              |
| --------------- | --------------------------------------------------- |
| `--check`       | Print each repo path + any pending task file; run nothing |
| `--check`       | also reports whether the herdr server is up               |
| `--interactive` | Legacy tmux mode: drop `--dangerously-skip-permissions`; inherit stdin |

## Notes

- Requires Node ≥ 20 and `claude` on `PATH`. No npm dependencies. `useHerdr` also
  needs `herdr` on `PATH` and `dev.herdr.server` running.
- A repo whose `CLAUDE.md` forbids committing will complete the task but leave HEAD
  unchanged — the log says so and no push is attempted.
