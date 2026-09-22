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

Connect the board to its GitHub repo on todzz.eu and set the *agent list* — the column
that means "ready for Claude". That is the whole of it. Within `onboardMinutes` each
running daemon notices the new board and sets itself up for it; the phone gets a
`Runner ＋ new repo` when it is watched. A card entering the agent list then makes the
server write `NNN-slug-TODO.md` into the repo and push it.

To do it now rather than wait — or to repair a repo whose setup half-finished — run it
by hand, which also drives the peer over ssh:

```bash
npm run onboard          # --dry-run first if you want to see the plan
```

Either way it reads every connected, unarchived board and does the rest:

| It does | How it decides |
| ------- | -------------- |
| Finds the clone, or makes one | An existing checkout whose `origin` is that repo wins, wherever it was filed. Otherwise `gh repo clone` into `customers/<repo>` when the board has a client, `<repo>` when it does not |
| Adds it to `config.json` | Only repos not already listed — a hand-placed path like `ezy/ezy-iot` is never rewritten. The daemon reloads the file each tick, so there is nothing to restart |
| Enables `dev-kit@klarity` for the repo | Merged into the repo's own `.claude/settings.json`, keeping whatever is already in it |
| Gives it a task folder | `doc/todo/`, unless the repo already keeps one at `.claude/todo/` |
| Writes a `CLAUDE.md` stub | Only when there is none: the repo, the detected stack, and the `/plan` → `/todo` → `/verify` table |
| Installs dependencies | Fresh clones only, by lockfile: pnpm / bun / yarn / `npm ci` / `uv sync` / `go mod download` / `cargo fetch`. `--no-install` skips it |
| Commits and pushes all of it | An untracked file outside the task folder is a dirty tree to preflight, which would block the repo forever. The commit is path-scoped, so a repo mid-edit keeps its own work out of it |

The automatic sweep is this machine only: Karel watches the same boards and adopts
them itself, so an ssh pass from inside its tick loop would only duplicate the work.
The hand-run command still drives the peers in `config.json` over ssh — the peer pulls
this repo first, so both machines run the same version — and Karel ends up with the identical
clone, config entry and plugin, except that it just pulls the setup commit the first
machine pushed:

```json
{
  "codeRoot": "~/Documents/GitHub",
  "peers": { "karel": "~/Documents/GitHub/klarity-claude-kit/plugins/dev-kit/runner" }
}
```

Leave `peers` off on the peer itself. Re-running is safe and is the point: it is how a
board connected last week catches up. Nothing here picks the **machine** a task runs
on — that is the task file's `> Machine:` line, below.

Still manual, once per machine, not per project:

```bash
claude plugin marketplace add kasparpalgi/klarity-claude-kit
claude plugin install dev-kit@klarity
```

A repo's `CLAUDE.md` must let `/todo` commit to the base branch. One that tells agents
to branch per task still works, but every card stops for a manual merge — see *Task
left on a branch* below. Check the result with `npm run check`.

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
| A run that ends **clean** but never renamed the file | Finishes the bookkeeping the agent skipped — renames to `-DONE`, notes it, commits, pushes, moves the card — and reports **✔**. A clean tree means nothing was left half-done, so this is the common "already complete / nothing to do" ending, not a failure |
| A run that ends with the tree **dirty** | **⚠ did not finish**: parks the uncommitted work in a stash (recoverable with `git stash pop`) and names what was left. Exit 0 only means the agent stopped talking, so this is checked, never assumed |
| A task that runs but keeps leaving the tree dirty | Two attempts, then **⏭ stuck task** once and that number is skipped so the queue advances. Editing the task file resets the count |

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

### Follow-up questions after a run

A finished run **leaves its pane open** at the herdr prompt, so you can type follow-up
questions to the same session from the phone. This is a courtesy, not a gate:

- **The next task starts on its own.** The daemon already recorded the run as finished the
  moment the agent went idle — it renamed the file, pushed, and moved the card before the
  pane was ever left open. On the next poll (`pollSeconds`) it picks the next `-TODO.md`
  and `reap()` closes your left-open `task-*` pane to reclaim it. You do **not** trigger
  anything; a left-open pane never blocks the queue.
- **You do not need to `/exit`.** `/exit` only ends Claude inside that one pane — the runner
  is a separate launchd daemon and does not watch it, so exiting neither starts nor speeds
  up the next task. Leave the pane or close its tab; either way the next run reaps it.
- **If a run looks finished in the pane but the card never moved,** the agent walked past
  step 6 (it said "already complete, nothing to do" and stopped without renaming). The
  runner now finishes that bookkeeping itself on a clean tree — see the guard table above —
  so this no longer leaves a dead queue slot to rename by hand.

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

### Claude pricing sync (launchd)

Keeps `claude_model_pricing` in Hasura current from LiteLLM's price list, every ~3
days:

```bash
node scripts/fetch-claude-pricing.mjs --dry-run   # preview, no write
node scripts/fetch-claude-pricing.mjs             # fetch + upsert

# Auto-run on macOS (separate daemon from the task runner above):
cp launchd-pricing.plist.example ~/Library/LaunchAgents/eu.todzz.claude-pricing.plist
# Edit: PATH, WorkingDirectory, HOME
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/eu.todzz.claude-pricing.plist
tail -f ~/Library/Logs/claude-pricing.log
```

It reads `endpoint`/`adminSecret` from the same `config.json` as the task runner —
no separate credentials to manage.

### Per-session token usage

After every run — finished, failed or stopped at the usage wall — the runner reads
the session transcript Claude Code left in
`~/.claude/projects/<cwd-slug>/<session-id>.jsonl` and upserts one `claude_usage`
row (`src/sessionUsage.js`): tokens per model, API-list cost from
`claude_model_pricing`, and the card it belonged to. The row is keyed on
`session_id`, so re-ingesting a transcript refreshes it instead of double-counting.
The log line reads `usage: claude-opus-5 2271895 in / 29536 out → $2.3296`.

Two things it deliberately tolerates: a model with no price row yet (LiteLLM lags a
brand-new id by days) costs 0 and is named in the log, and a run whose transcript
cannot be found is a log line, not a failure. Needs `endpoint`/`adminSecret` in
`config.json`; without them the runner skips this entirely.

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
3. List every `NNN-slug-TODO.md` with no `NNN-slug-DONE.md` (or `-BLOCKED.md`) **of its
   own stem**, lowest number first, and take the first one that has not already used up
   its two attempts. Retirement matches the whole `NNN-slug`, never the bare `NNN`:
   numbers were "next free slot in the folder" before task-014 and are the GitHub issue
   number after it, so two unrelated tasks can share one, and keying on the number alone
   made the newer of the pair invisible the moment the server wrote it.
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
| `machine`        | this computer's id — a string or a list of spellings it answers to. Unset means it is the only runner and takes every task |
| `machineDefault` | this machine also takes tasks with no `> Machine:` line (default false) |
| `codeRoot`       | where onboarding looks for clones and puts new ones (default `~/Documents/GitHub`) |
| `onboardMinutes` | how often the daemon adopts newly connected boards (default 5; `0` turns it off) |
| `peers`          | host → this runner's folder on it; `npm run onboard` repeats itself there over ssh. Omit on the peer |

## Which machine runs it

More than one computer can watch the same repos — a Mac and an Ubuntu box, each with
its own clone, its own herdr and its own daemon. They also see the same `-TODO.md`
files, so without an owner per task they would both pick the lowest one on the same
tick and run it twice.

The task file names the owner, right under the tier line:

```
> Run with: Opus 5 / high
> Machine: karel
```

Each runner sets its own id in `config.json` and takes only the tasks addressed to it:

```json
{ "machine": "karel" }                        // Karel, the Ubuntu box
{ "machine": "mac", "machineDefault": true }  // this Mac
```

A file with **no** `> Machine:` line is unaddressed — every task file written before
this existed. Exactly one machine may claim those, the one with `machineDefault`.
Leave it off everywhere else, or the double-run comes back.

`machine` also accepts a list (`["karel", "karel-ubuntu"]`) so a board label spelled
differently than the config still lands. A task addressed to a name **no** runner
answers to is not an error anywhere — it simply never runs. `--check` is where you
see that: it prints `[→ karel, not this machine]` next to every pending task that
belongs elsewhere.

Setting `machine` on a single-runner setup is optional; unset means "the only machine
there is", which is what every existing install keeps doing.

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

### Usage limits

There's no API for the runner to ask "how much session is left" ahead of time — it only
finds out when the CLI itself says the wall was hit. When a run's output shows that, the
runner steps the tier down one notch (`src/classify.js`'s `downgrade`: effort first, then
family) and retries the same task immediately, since a cheaper tier spends the usage
budget slower. Once it's already at `haiku / low` and still hits the wall, it stops
retrying and waits: every repo sits idle until the reset time recorded in
`src/state.js`'s `cooldownUntil`. That moment comes from the CLI's own message — the
headless `| <epoch>`, or the human `resets 5:40pm (Europe/Tallinn)` wording an
interactive/herdr-pane run prints (`src/usage.js` turns the clock time + IANA zone into
the exact instant). Only a limit message with no time at all falls back to a fixed wait
(5h session, 7 days weekly). Because the wall is the account's state and not the task's
fault, the attempt it consumed is given back, so a run that started with almost no budget
left doesn't count toward the 3-strikes skip. `--check` and the `Runner ⏳ usage limit`
notification both surface that timestamp, in local time.

## CLI flags

| Flag            | Effect                                              |
| --------------- | --------------------------------------------------- |
| `--check`       | Connected boards and any not yet onboarded, then per repo: path, current branch, task folder, dirty paths, blocked reason, pending tasks with attempt counts — plus whether the herdr server is up. Runs nothing |
| `--once`        | Run a single tick and exit. For tests and manual pokes |
| `--interactive` | Legacy tmux mode: drop `--dangerously-skip-permissions`; inherit stdin |

`npm run onboard` (`src/onboard.js`) takes its own:

| Flag | Effect |
| ---- | ------ |
| `--dry-run` | Print the plan — which repos are missing, where each would land. Writes nothing |
| `--no-install` | Clone and configure, but do not run the stack's install command |
| `--all` | Re-scaffold every connected board's repo, not just the ones missing from `config.json` — the repair path when a clone was left stale or a setup commit did not push |
| `--no-peers` | This machine only. Passed automatically to each peer, so they never recurse |

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
| `Runner ⏭ stuck task` | two runs, no `-DONE` rename; the task is skipped |
| `Runner ＋ new repo` | a newly connected board was cloned, scaffolded and is now watched |
| `Runner ⚠ cannot onboard` | a connected board's repo would not clone or scaffold — said once, not every sweep |

## Files

| File | Role |
| ---- | ---- |
| `src/run.js`     | tick loop, one task per tick, `--check` |
| `src/repo.js`    | git preflight: dirt classification, branch, fetch/pull |
| `src/queue.js`   | task folder → pending list, attempt-limited pick |
| `src/state.js`   | `~/.kanban-runner/state.json`: blocked reasons, attempt counts |
| `src/herdr.js`   | run Claude in a herdr pane, wait out blocks |
| `src/classify.js`| model + effort tier for a task file |
| `src/pricing.js` | LiteLLM price list → `claude_model_pricing` rows |
| `src/sessionUsage.js` | read a run's transcript → one `claude_usage` row |
| `src/onboard.js` | connected boards → clones, `config.json` entries, the peer machine. The daemon calls it on a timer |
| `src/scaffold.js`| one clone → plugin enabled, task folder, CLAUDE.md, dependencies |
| `src/notify.js`  | Pushbullet |

## Notes

- Requires Node ≥ 20 and `claude` on `PATH`. No npm dependencies. `useHerdr` also
  needs `herdr` on `PATH` and `dev.herdr.server` running.
- A repo whose `CLAUDE.md` forbids committing will complete the task but leave HEAD
  unchanged — the log says so and no push is attempted.
