# Kanban runner

A personal daemon that watches local git clones for new `doc/todo/NNN-*-TODO.md` files
and runs `/todo NNN` against them via `claude`. No Hasura, no admin secret, no public
endpoint.

```
card enters the agent list on todzz
   └─ server writes NNN-slug-TODO.md and pushes            (task-014)
       └─ runner tick: clean the tree, return to base, pull
           └─ claude in a herdr pane  →  visible on the phone
               ├─ needs you  →  Pushbullet  →  answer in the relay PWA
               └─ /todo renames to NNN-slug-DONE.md, commits, pushes
                   └─ push webhook moves the card                (task-016)
```

The `-DONE.md` rename **is** the state. No database, no marker files — restart is safe.

> **Personal opt-in tooling, not the product.** A user who never installs this loses
> nothing. The product path is task-014 (server writes the file) + task-016 (push webhook).

## Connect a new project

Three things have to line up: the **board**, the **repo**, and the **path on this Mac**.

1. **Board → repo.** On todzz.eu open the board, connect it to its GitHub repo, and set
   the *agent list* — the column that means "ready for Claude". A card entering that list
   makes the server write `NNN-slug-TODO.md` into the repo and push it.

2. **Clone the repo onto this Mac.** The runner only ever watches local clones:

   ```bash
   git clone git@github.com:owner/repo.git ~/Documents/GitHub/repo
   ```

   Anywhere works — `~/Documents/GitHub/<repo>` is the convention here. Note the path;
   step 3 needs it.

3. **Add that path to `config.json`** (in this folder, gitignored). The key is
   `owner/repo` as GitHub spells it, the value is the **absolute path on this Mac** —
   `~/` is expanded at runtime:

   ```json
   {
     "pollSeconds": 20,
     "useHerdr": true,
     "repos": {
       "kasparpalgi/svelte-hasura-boilerplate": "~/Documents/GitHub/svelte-hasura-boilerplate",
       "kasparpalgi/my-new-project": "~/Documents/GitHub/my-new-project"
     }
   }
   ```

4. **Give the repo a task folder** — `doc/todo/` or `.claude/todo/`. The runner prefers
   `.claude/todo` when it exists and falls back to `doc/todo`.

5. **Install the dev-kit plugin** once per machine, so the repo has `/todo`:

   ```bash
   claude plugin marketplace add kaspar-palgi/klarity-claude-kit
   claude plugin install dev-kit@klarity
   ```

6. **Check, then restart the daemon:**

   ```bash
   npm run check                                       # paths, branches, pending tasks
   launchctl kickstart -k gui/$(id -u)/eu.todzz.kanban-runner
   tail -f ~/Library/Logs/kanban-runner.log
   ```

The repo's `CLAUDE.md` must let `/todo` commit to the base branch. A repo that tells
agents to branch per task will still work, but every card stops for a manual merge — see
*Task left on a branch* below.

## Guards — why it never wedges

The runner used to log `skip <repo> — dirty working tree` every 20 seconds forever, with
nothing on the board moving and no signal anywhere. Each state below is now either
self-healed or announced exactly once, on the edge.

| State | What the runner does |
| ----- | -------------------- |
| Dirt only inside the task folder | Commits it as `chore(todo): checkpoint uncommitted agent output` and carries on — that is a half-finished agent run, not your work |
| Dirt anywhere else | Skips the repo and sends **⛔ blocked** listing the paths. Silent on every later tick; **▶ unblocked** when the tree is clean again |
| On a task branch with unpushed commits | Pushes the branch, returns to the base branch, sends **↗ task on a branch**. Nothing is lost and the queue keeps moving; you merge when ready |
| On a task branch already merged | Silently returns to the base branch |
| Detached HEAD, unreachable origin, diverged base | Skips with **⛔ blocked** naming which one |
| A run that ends with the file unrenamed or the tree dirty | **⚠ did not finish**, naming exactly what was left behind. Exit 0 only means the agent stopped talking, so this is checked, never assumed |
| A task that runs but never renames itself | Two attempts, then **⏭ stuck task** once and that number is skipped so the queue advances. Editing the task file resets the count |

Attempt counts and blocked reasons live in `~/.kanban-runner/state.json` — deliberately
outside every repo, so runner bookkeeping can never dirty a working tree. Delete the file
to forget everything.

The base branch is `origin/HEAD` (usually `main`), never assumed.

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
`"unattended": true` to go back to `--dangerously-skip-permissions`.

**This machine runs `"unattended": true`.** `acceptEdits` sounded safer but cost more than
it saved: the model spends tokens deciding each call, and it still interrupts for things
that are not interesting — including editing the task file it was told to edit. Blocks are
still reported to the phone if one happens; there are just far fewer of them.

Safety rails:

- herdr server down or `useHerdr` false → falls back to the headless child, logged as
  `herdr down — falling back to headless`. It never wedges on herdr's absence.
- A block nobody answers within `blockedMinutes` closes the tab and leaves the task
  file as `-TODO`, so the queue advances.
- Any surviving `task-*` agent is a leak from a crashed run and is reaped at the start
  of the next one.

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

### Legacy: tmux + `--interactive`

`--interactive` predates the herdr path: it drops `--dangerously-skip-permissions` and
inherits stdin, so it only works when you attach a terminal yourself. Prefer
`useHerdr`.

## How it works

Each tick (one per `pollSeconds`), for each configured repo:

1. **Preflight** — classify any dirt, return to the base branch, `git fetch` and
   `git pull --ff-only`. Anything unresolvable skips the repo with one notification
   (see *Guards* above).
2. Find the task folder (`.claude/todo` if it exists, else `doc/todo`).
3. List every `NNN-*-TODO.md` with no matching `NNN-*-DONE.md`, lowest first, and take
   the first one that has not already used up its two attempts.
4. Read the `> Run with:` frontmatter line (written by task-014). Classify with a
   cheap Claude call if the line is missing; default to `Sonnet 5 / medium` on failure.
5. Run `/todo NNN` — in a herdr tab when `useHerdr` is on, otherwise as
   `claude -p "/todo NNN" --model … --effort …`.
6. Save the full session output next to the task file as `NNN-slug.log`, and push the
   last 15 lines to the phone (success and failure alike).
7. If HEAD advanced (i.e. `/todo` committed), `git push origin HEAD`.

Logs are gitignored: the first run in a repo commits `*.log` to the task folder's
`.gitignore`, so transcripts never dirty the tree or reach the remote.

**One task per tick.** The loop returns after the first task it runs, so repos queue
naturally.

## Where the logs are

| Log | What is in it |
| --- | ------------- |
| `~/Library/Logs/kanban-runner.log` | the daemon's own tick log — every skip, run, push and reason. `tail -f` this first |
| `<repo>/<task dir>/NNN-slug.log` | the full Claude session transcript for that task, written after every run, gitignored |
| `~/.kanban-runner/state.json` | current blocked reason per repo and attempt count per task |
| `npm run check` | the same picture as state.json, rendered, plus herdr's status |
| herdr, at `https://herdr.servicehost.io` | the live pane while a task is running |

The daemon log is stdout/stderr from launchd, so its path is whatever
`launchd.plist.example` sets — change it there, not in the code.

## Config

`config.json` is gitignored.

| Key           | Meaning                                                       |
| ------------- | ------------------------------------------------------------- |
| `pollSeconds`    | how often to pull (default 60)                                 |
| `repos`          | `"owner/repo"` → local clone path; `~/` is expanded at runtime  |
| `useHerdr`       | run Claude in a herdr pane, visible on the phone (default false) |
| `unattended`     | on the herdr path, skip permissions instead of asking (true here) |
| `taskMinutes`    | cap on one `/todo` run (default 45)                             |
| `blockedMinutes` | how long to wait for a human to answer a prompt (default 30)    |

## Model & effort

The task file's first line decides:

```
> Run with: Opus 4.8 / xhigh
```

**Family + version** together select the model. The version is *not* decoration: the
runner passes the full model id (`--model claude-opus-4-8`), so `Sonnet 4.6` really runs
Sonnet 4.6. A bare family name means that family's latest. A version that is not in the
table falls back to the family's latest rather than failing the run.

**Effort** after the slash — `low`, `medium`, `high`, `xhigh`, `max` — is passed through
as `--effort`. Omit it and the family's default applies. Effort and version are
independent: `Sonnet 4.6 / max` and `Opus 5 / low` are both legal.

Everything lives in one table, `FAMILIES` in `src/classify.js`:

| Family   | Versions           | Latest | Default effort |
| -------- | ------------------ | ------ | -------------- |
| `fable`  | 5.1                | 5.1    | high           |
| `opus`   | 4.6, 4.8, 5        | 5      | high           |
| `sonnet` | 4.6, 5             | 5      | medium         |
| `haiku`  | 4.5                | 4.5    | low            |

Add a version by putting its model id in that family's `versions`.

With no `Run with:` line at all, a cheap haiku call picks a *family* (version and effort
stay at that family's defaults) and falls back to `Sonnet 5 / medium`. Fable is never
auto-chosen — it bills usage credits, so it has to be asked for by name.

Task-014 writes the line from the card's model/effort fields, so the tier is normally
chosen from the board rather than typed.

## CLI flags

| Flag            | Effect                                              |
| --------------- | --------------------------------------------------- |
| `--check`       | Per repo: path, current branch, task folder, dirty paths, blocked reason, pending tasks with attempt counts — plus whether the herdr server is up. Runs nothing |
| `--once`        | Run a single tick and exit. For tests and manual pokes |
| `--interactive` | Legacy tmux mode: drop `--dangerously-skip-permissions`; inherit stdin |

## Phone notifications

Pushbullet, via `PUSHBULLET_ACCESS_TOKEN`. No token means every notification is a
silent no-op and nothing else changes.

| Title | Meaning |
| ----- | ------- |
| `Runner ✔` / `Runner ✘` | a task finished / exited non-zero |
| `Runner ⏸ needs you` | the agent is blocked on a prompt — answer it in the relay PWA |
| `Runner ⛔ blocked` / `Runner ▶ unblocked` | a repo stopped / resumed being processable |
| `Runner ↗ task on a branch` | work was left on a task branch, pushed, waiting for your merge |
| `Runner ⚠ did not finish` | the agent stopped without renaming the file or committing |
| `Runner ⏭ stuck task` | two runs, no `-DONE` rename; the number is skipped |

## Files

| File | Role |
| ---- | ---- |
| `src/run.js`     | tick loop, one task per tick, `--check` |
| `src/repo.js`    | git preflight: dirt classification, branch, fetch/pull |
| `src/queue.js`   | task folder → pending list, attempt-limited pick |
| `src/state.js`   | `~/.kanban-runner/state.json`: blocked reasons, attempt counts |
| `src/herdr.js`   | run Claude in a herdr pane, wait out blocks |
| `src/classify.js`| model + effort tier for a task file |
| `src/notify.js`  | Pushbullet |

## Notes

- Requires Node ≥ 20 and `claude` on `PATH`. No npm dependencies. `useHerdr` also
  needs `herdr` on `PATH` and `dev.herdr.server` running.
- A repo whose `CLAUDE.md` forbids committing will complete the task but leave HEAD
  unchanged — the log says so and no push is attempted.
