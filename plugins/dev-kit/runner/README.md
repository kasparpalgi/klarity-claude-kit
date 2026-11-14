# Kanban runner

A personal daemon that watches local git clones for new `doc/todo/NNN-*-TODO.md` files
and runs `/todo NNN` against them via `claude`. No Hasura, no admin secret, no public
endpoint. It reaches the Kanban only through its runner API
(`POST <appUrl>/api/runner/<op>`, bearer `apiToken` — `src/kanban.js` `runnerApi`).

```
card enters the agent list on todzz
   └─ server writes NNN-slug-TODO.md and pushes            (task-014)
       └─ runner tick: clean the tree, return to base, pull
           └─ the task's own worktree, ~/.kanban-runner/worktrees/<repo>/<stem>
               └─ claude in a herdr pane  →  visible on the phone
                   ├─ needs you  →  ntfy  →  answer in the relay PWA
                   └─ /todo renames to NNN-slug-DONE.md, commits, pushes
                       └─ runner lands it, removes the worktree, moves the card
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
| Finds the clone, or makes one | An existing checkout whose `origin` is that repo wins, wherever it was filed, and under any name GitHub redirects to it. Otherwise `gh repo clone` into `customers/<repo>` when the board has a client, `<repo>` when it does not |
| Adds it to `config.json` | Only repos not already listed — a hand-placed path like `ezy/ezy-iot` is never rewritten. The daemon reloads the file each tick, so there is nothing to restart |
| Enables `dev-kit@klarity` for the repo | Merged into the repo's own `.claude/settings.json`, keeping whatever is already in it |
| Gives it a task folder | `doc/todo/`, unless the repo already keeps one at `.claude/todo/` |
| Writes a `CLAUDE.md` stub | Only when there is none: the repo, the detected stack, and the `/plan` → `/todo` → `/verify` table |
| Installs dependencies | Fresh clones only, by lockfile: pnpm / bun / yarn / `npm ci` / `uv sync` / `go mod download` / `cargo fetch`. `--no-install` skips it |
| Commits and pushes all of it | An untracked file outside the task folder is a dirty tree to preflight, which would block the repo forever. The commit is path-scoped, so a repo mid-edit keeps its own work out of it |

A repo renamed or transferred on GitHub stays one repo. `gh api repos/<owner>/<repo>`
gives its current name, and the board, the `config.json` entry (with `pullRequests` and
`seo`) and the clone are all matched on that name, so the existing clone is adopted. A
board or entry still holding the old name is updated to the new one. If GitHub cannot be
asked, the sweep neither clones nor removes anything, and the phone gets
`Runner ⚠ cannot onboard`.

## Archive or delete a project

Archive the board, or delete it. On its next sweep every daemon drops the repo from
its own `config.json` and deletes its clone, and the phone gets `Runner － repo removed`.
A clone that holds work found nowhere else is left on disk and only unwatched:
uncommitted changes, commits on no remote, a stash, an open worktree. Its gitignored
secrets (`.env*`, `hasura/config.yaml`, `.secrets/`) are first copied to
`~/.kanban-runner/archived/<owner>__<repo>/`.

Restoring the board from the archive is the reverse, with nothing to do: the repo is no
longer in `config.json`, so onboarding treats it as new, clones it again and puts the
saved secrets back. A deleted board leaves no row to read, so the runner remembers which
repos had a live board on its last sweep (`boarded` in `state.json`). A repo you added
to `config.json` by hand, with no board, is never removed.

The automatic sweep is this machine only: Karel watches the same boards and adopts
them itself, so an ssh pass from inside its tick loop would only duplicate the work.
The hand-run command still drives the peers in `config.json` over ssh — the peer pulls
this repo first, so both machines run the same version — and Karel ends up with the identical
clone, config entry and plugin, except that it just pulls the setup commit the first
machine pushed:

```json
{
  "codeRoot": "~/Documents/GitHub",
  "peers": {
    "karel": "~/Documents/GitHub/klarity-claude-kit/plugins/dev-kit/runner",
    "dell": "~/Documents/GitHub/klarity-claude-kit/plugins/dev-kit/runner",
    "winwsl": "~/Documents/GitHub/klarity-claude-kit/plugins/dev-kit/runner"
  }
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
| Dirt anywhere else | Skips the repo and sends **⛔ blocked** listing the paths. Silent on every later tick, except **⛔ task waiting** once for each new task origin queues for this machine meanwhile (it fetches, never pulls); **▶ unblocked** when the tree is clean again |
| The clone on a task branch with unpushed commits | Pushes the branch, returns to the base branch, sends **↗ task on a branch**. Nothing is lost and the queue keeps moving; you merge when ready |
| The clone on a task branch already merged | Silently returns to the base branch |
| Detached HEAD, unreachable origin, diverged base | Skips with **⛔ blocked** naming which one |
| A run that ends **clean** but never renamed the file | Finishes the bookkeeping the agent skipped — renames to `-DONE`, notes it, commits, pushes, moves the card — and reports **✔**. A clean tree means nothing was left half-done, so this is the common "already complete / nothing to do" ending, not a failure |
| A run that ends with its tree **dirty** | **⚠ did not finish**: parks the uncommitted work in a stash (recoverable with `git stash pop` from the clone — stashes are shared with the worktree) and names what was left. Exit 0 only means the agent stopped talking, so this is checked, never assumed. The dirt was in the task's worktree, never the clone, so the next task starts regardless |
| A session that switched branch, rebased halfway or broke its tree | Only its worktree is affected: no agent ever runs in the clone (see *Every task in its own worktree*). Commits on a branch of the session's own making are pushed there with **↗ task on a branch**, never landed on the base branch |
| Its commits will not land (rebase conflict, push refused) | **✘ did not land**: the worktree stays with the work in it, and the next attempt continues there. The clone and every other task move on |
| A worktree left behind (its pane still worked, a usage-limit retry, a runner restart) | Each tick sweeps the repo's worktrees: one whose task is finished in it or no longer queued, with no live pane, is landed (push-to-main) or removed when nothing on it is lost (pull request repo). Its local branch goes once it is all on origin, and so does its trust entry in `~/.claude.json` |
| A task that runs but keeps leaving the tree dirty | Two attempts, then **⏭ stuck task** once and that number is skipped so the queue advances. Editing the task file resets the count. The skip also files and pushes `NNN-unstick<N>-TODO.md` (`src/unstick.js`), addressed to this machine with that reason in brackets (the stuck run's `.log` is here), so a usage wall never hands it away at the task's own `> Run with:`: it reads the transcript and the stash, then finishes the task or renames it `-BLOCKED`. One fixer per task number, and a stuck fixer gets none, so it can never loop |
| The second attempt at a task | Runs `/todo NNN <note>`: the note says how attempt 1 ended (the reason, the stash commit holding its work, its `NNN-slug.log`), so it resumes instead of starting cold. The note lives in state.json, never in the task file, because editing the file resets the count. Attempt 1 is always the bare `/todo NNN` |
| A card dragged out of the agent list mid-run | The tick loop is parked inside the run, so the run watches its own card: every `pollSeconds` it fetches origin's base branch into a private ref (never a pull, never `origin/*`, so it cannot race the agent's own `git pull`). Once the task was seen there and then has no `-TODO`/`-DONE`/`-BLOCKED` file left — renamed back to a draft or deleted — it closes the pane and kills its own `herdr` wait (a pending `agent wait` ignores its tab closing until it times out). Commits the agent made but never pushed are soft-reset (push-to-main repos), then the worktree's dirt is stashed, the worktree closed, and **⏹ stopped — card left the agent list** names the stash. The attempt is given back; moving the card back writes a fresh `-TODO` that queues normally. In a pull-request repo the branch keeps any commits for the next run |

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

**The phone opens a pane in Conversation view** (relay 0.23.0+): only the prompt and the
latest answer, with a **Speak** button — not the tool calls. Both views stay one tap apart:
the header's **terminal icon** (a box with `>_`) opens the full live Claude Code pane, and the
**book icon** there goes back to the short view. **Full history** lists every message and
tool call. To land on the terminal every time, set **Settings → Agents → Default View →
Terminal**. A per-pane choice does not carry over: each run is a new `task-NNN` pane.
"Branch unverified" shows on every Claude pane and is harmless. "No user prompts or agent
answers…" means the newest page of the run is all tool calls: tap **Load older turns**, or
open the terminal.

**Flicker in the phone browser** comes from the relay app redialing, not from the runner
(#11). The relay logs on karel and dell show the phone dropping both at the same second and
redialing every 1–3 s for up to a minute. Chrome on Android tells the app when the network
changes. The app then pings every relay and redials any that is silent for 2 s. Each redial
reloads the open view. With **Settings → Terminal → Resize Session** on (the default again
since 0.23.0), it also resizes the pane twice, and Claude repaints each time. Turn Resize
Session off, or read in Conversation view, which never resizes.

**Native Android apps.** The official [Herdr app](https://play.google.com/store/apps/details?id=dev.herdr.app)
works only with herdr-core, so it does not see runner panes in the Herdr TUI server.
[herdr-android](https://github.com/makefunstuff/herdr-android/releases/latest) is a
third-party APK. It connects to the TUI server over SSH and opens an agent in its chat. Its
terminal is sized to the phone too.

Permissions use `--permission-mode acceptEdits`: file edits — the bulk of a `/todo`
run — flow without prompting, while Bash and destructive operations still ask. An
asking agent settles to `blocked`, which sends a phone note **"Runner ⏸ needs you"**
with the pane text; answer it in the relay PWA and the run continues. Set
`"unattended": true` to go back to `--dangerously-skip-permissions`.

**This machine runs `"unattended": true`.** `acceptEdits` sounded safer but cost more than
it saved: the model spends tokens deciding each call, and it still interrupts for things
that are not interesting — including editing the task file it was told to edit. Blocks are
still reported to the phone if one happens; there are just far fewer of them.

Safety rails:

- **A fresh clone is trusted before the pane opens.** Claude asks "do you trust the
  files in this folder?" the first time it starts interactively somewhere new. `-p`
  skips that dialog, so the headless path never met it — but a pane is a real TTY,
  and there it is a wall: the agent never registers, the log is two lines, and the
  task burns an attempt. The runner now writes `hasTrustDialogAccepted` into
  `~/.claude.json` for the repo before every run, once per repo (task-032).
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

### Remote Control — the same run in the Claude app

Set `"remoteControl": true` and the pane starts as
`claude --remote-control <repo>-<NNN-slug>` (svelte-hasura-boilerplate#85). The run
then also shows in **claude.ai/code** and the **Claude app** (Code tab), with diffs, a
chat UI and image attachments, and you can type to it from there. The card's live status
line ends with the session's `https://claude.ai/code/session_…` link, so one tap from the
board opens it. herdr and ntfy keep working exactly as before. The app is a second
window, not a replacement, and the runner still decides everything from the pane.

- **Per machine, off by default.** A session lands in the account that machine's `claude`
  is logged in to. Turn it on only where that account is yours. Karel's is (checked in #85); check
  another machine with `claude auth status`.
- **No first-run dialog.** Measured on 2.1.322: the `--remote-control` flag connects
  without the "Enable Remote Control?" question that `claude remote-control` and
  `/remote-control` ask, so the pane never waits on it.
- **Headless runs don't get it.** Remote Control needs an interactive session, so the
  `-p` fallback runs without it.
- **The link without the flag.** With `"remoteControlAtStartup": true` in a machine's
  `~/.claude/settings.json`, every session is in claude.ai/code anyway. The runner reads
  the link from the run's transcript (its `bridge-session` line) and adds it to the
  status line as soon as it shows, `remoteControl` or not (svelte-todo-kanban#221).
- **Native push.** To have the Claude app ping you too, run `/config` in `claude` once on
  that machine and turn on *Push when actions required*.

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

Keeps `claude_model_pricing` in the Kanban current from LiteLLM's price list, every ~3
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

It reads `apiToken` from the same `config.json` as the task runner —
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
cannot be found is a log line, not a failure. Needs `apiToken` in
`config.json`; without them the runner skips this entirely.

### Live status on the card

When a run starts the runner posts **one** comment on its card —
`▶ Running on dell since 14:02 · Opus 5.5 / xhigh · attempt 1` — and edits that same
comment (by id) as the run goes: `⏳ Waiting` at the usage wall, `⏸ Needs you` when the
pane blocks, `✘ Failed` / `⚠ Did not finish`, and finally
`■ Finished on dell 14:02–14:41 · … · $2.33` with the cost from `sessionUsage.js`. A
retry takes over the comment its unfinished attempt left; a `■ Finished` one is kept, so
a card sent back for rework gets a fresh line. A task queued behind a blocked repo gets
`⏳ Waiting on dell since 14:02 · repo blocked: <reason>` the same way (once per task, #5). The Results comment stays separate. The
Kanban's `cardThread.ts` drops these prefixes (`STATUS` in `src/status.js`) when it
carries the thread into a re-queued task file — change both together. Its push webhook
also leaves a card that carries one to the runner, so a finished card gets one close: no
"✅ Task complete" beside the Results. `closeLoop` posts the Results on the card before
the issue, so the webhook links the issue's copy instead of adding it again (#80).

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
5. Open the task's worktree (see below) and run `/todo NNN` there — in a herdr tab when
   `useHerdr` is on, otherwise as `claude -p "/todo NNN" --model … --effort …`.
6. Save the full session output next to the task file in the clone as `NNN-slug.log`,
   and push the last 15 lines to the phone (success and failure alike).
7. Land what the session committed on the base branch, remove the worktree,
   fast-forward the clone, and close the card.

### Every task in its own worktree

No agent ever runs in the clone (#91). A dirty tree, a branch switch or a rebase left
halfway used to sit in the clone and stall every later task in the repo (tasks 005, 026,
046, 060). Now each task gets `~/.kanban-runner/worktrees/<repo>/<stem>`, with the clone's
gitignored secrets and, with a lockfile, `npm ci` (the pane opens after it; the journal
says `npm ci in the new worktree`).

- **Push-to-main repos** run on branch `run/<stem>`, made from the clone's `HEAD` and
  tracking `origin/main`, so the agent's `git pull` works as usual. `/todo` pushes with
  `git push origin HEAD:main` (git will not check `main` out twice). When the session
  ends, the runner commits task-folder-only dirt, parks the rest in a stash, rebases
  anything unpushed onto `origin/main` and pushes it, removes the worktree and its
  branch, and fast-forwards the clone. An older `/todo` that runs `git push origin main`
  pushes nothing of its own, and the runner lands its commits all the same.
- **Pull-request repos** run on `todo/<stem>` and ship as a PR (see *Pull-request repos*).
- **Kept** while its pane still works, for the retry after a usage limit (which reuses it
  as it is), and when its work would not land. The sweep removes it once its task is over.
- **Cleaned up** with it: the `node_modules`, the local branch once it is all on origin
  (and, once per runner start, every `run/*` / `todo/*` branch already on origin), the
  empty `<repo>` folder and the dead trust entries in `~/.claude.json`. Stashes stay — they
  are the recovery copy. Claude's own transcripts of a worktree stay in
  `~/.claude/projects/` for Claude Code's 30-day cleanup.

**Follow-ups get an issue first.** Whenever a repo's HEAD moves, a new suffixless
`NNN-slug.md` with no card of its own — split out by an agent, under the runner or
not — is filed as a GitHub issue, renamed to the issue's number when that number is
free, and put on the board's Backlog with the issue linked (`src/followup.js`). Only
repos with a connected board take part. Every runner sees the same commits, so the card
doubles as a lock: the first card in for a path wins and the others back off. The
winner moves its card to the new name only once the rename is on origin: a push that
fails is retried after `pull --rebase`, and one that still fails is undone, leaving the
file unrenamed and the card on the old path. A runner whose clone still has the old file
fetches before it files, and backs off when origin already moved it (klarity-claude-kit#2).

Logs are gitignored: the first run in a repo commits `*.log` to the task folder's
`.gitignore`, so transcripts never dirty the tree or reach the remote.

**Screenshots ride to the card.** For a UI task `/verify` saves 1–3 screenshots as
`<task dir>/NNN-slug-*.png`, gitignored the same way (`/[0-9]*-*.png`). When the card
moves to Review, closeLoop posts them to the Kanban app's `/api/runner/upload`
(`appUrl`, default `https://www.todzz.eu`, authenticated with `apiToken`), which stores
them like any card upload — the owner's R2 bucket, else the app's — and lists them on
the card. A task with no screenshots closes exactly as before.

**One task per tick.** The loop returns after the first task it runs, so repos queue
naturally.

**The runner updates itself.** Every ten minutes, between tasks, it fast-forwards its
own checkout; if that brought new commits it exits, and the supervisor (systemd
`Restart=always`, launchd `KeepAlive`) starts it again on the new code. Without this a
fix pushed from one machine simply never reaches the other — the daemon keeps ticking,
looking healthy, running last week's files, and a reboot does not help because it
restarts the same stale checkout. A dirty tree is left alone: that is someone working
in the repo, not a stale box.

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
| `remoteControl`  | on the herdr path, also open the session in claude.ai/code and the Claude app (default false). See *Remote Control* below |
| `cloud`          | send `> Machine: cloud` tasks to Claude Code cloud sessions (default false). One runner only, on the account the sessions should bill. See *Cloud* below |
| `handOver`       | at the usage wall, put this machine's waiting tasks back on Auto for a free runner (default false). See *Usage limits* |
| `taskMinutes`    | cap on one `/todo` run (default 240) — only a still-`working` agent ever reaches it, so it guards against a hung agent, not a long task. At 45, Opus/high tasks with an E2E run were parked mid-work and re-run (tekdok 034, kanban 206) |
| `blockedMinutes` | how long to wait for a human to answer a prompt (default 30)    |
| `machine`        | this computer's id — a string or a list of spellings it answers to. Unset means it is the only runner and takes every task |
| `codeRoot`       | where onboarding looks for clones and puts new ones (default `~/Documents/GitHub`) |
| `onboardMinutes` | how often the daemon adopts newly connected boards (default 5; `0` turns it off) |
| `seo`            | repos (`"owner/repo"`) that also get the claude-seo plugin — landing / marketing sites only. A board gets it too with `"seo": true` in its `github` JSON. For an already-onboarded repo, add it here and run `npm run onboard -- --all` |
| `peers`          | host → this runner's folder on it; `npm run onboard` repeats itself there over ssh, and the sweep pushes secrets there. Omit on the peer |
| `pullRequests`   | repos (`"owner/repo"`) where every change is a pull request — see below. Only a repo whose CI merges green PRs by itself belongs here, or its tasks never finish |

## Secrets on the peers

A clone brings the code, not the keys: `.env` is gitignored, so a peer that adopted a
board had none of them, and a task that needed a database URL failed there and passed
on the Mac. The Mac is the source. Every board sweep it hashes its gitignored secrets,
asks each peer for the same hashes in one ssh call, and sends only the files that differ:

```bash
npm run sync-secrets -- --dry-run   # what would go where
npm run sync-secrets                # do it now rather than wait for the sweep
```

| Rule | Why |
| ---- | --- |
| Files: `.env*` (not `.example`/`.sample`), `hasura/config.yaml`, `.secrets/` — only when gitignored | A committed file is git's job |
| Repos match by `owner/repo` key, not path | `job` is `customers/job` here and `job` on Dell |
| A differing file is overwritten from the Mac | One source of truth; edit secrets on the Mac |
| A file only the peer has is never touched | Put a peer-only override in a file the Mac does not have |
| A repo the peer has not cloned yet is skipped | Its own sweep adopts it; the secrets follow one sweep later |
| `COPYFILE_DISABLE=1` on the tar | macOS tar adds `._.env` beside each file — not gitignored, so it dirtied 14 repos on the peers and blocked them |

Only a machine with `peers` in its config pushes, which is the Mac alone. A peer that is
switched off is logged once, and again when it is back.

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
{ "machine": "karel" }                        // Karel, an Ubuntu box
{ "machine": "dell" }                         // Dell (servo), the other Ubuntu box
{ "machine": ["windows", "win", "karel2"] }   // WSL2 on the Windows PC (karel2)
{ "machine": "mac" }                         // this Mac
```

A note in brackets after the id is ignored — `> Machine: mac (the only one that can ssh
renlog)` is `mac`. Anything else that is no runner's id (`> Machine: one with ezy-iot
checked out`) waits forever; `--check` shows it as `[→ one-with-…, not this machine]`.

A machine at its usage wall gives its bare-addressed tasks away until the reset (see
*Usage limits*).

A file with **no** `> Machine:` line is unaddressed — "Auto" on the card. Any runner
may take it, but claims it first, in the Kanban: it sets the
card's machine compare-and-swap (the update matches only while the field is empty or
already its own), so when two runners race exactly one gets its row back. A task with
no card of its own — a failure CI filed, a review task an agent wrote — is adopted as a
TODO card first; the first card in for its path wins, as follow-ups are filed
(`src/claim.js`). A card deleted since the file was written is adopted anew, not read
as another runner's claim. With no Kanban to lock with (none configured, or no TODO list
on the repo's board) the claim is a pushed `chore(todo): claim NNN for karel` commit that
adds the `> Machine:` line, as before tektok-app's task 184: a push is atomic, and it
touches only the task file, which is bookkeeping even in a pull request repo.

`machine` also accepts a list (`["karel", "karel-ubuntu"]`) so a board label spelled
differently than the config still lands. A task addressed to a name **no** runner
answers to is not an error anywhere — it simply never runs. `--check` is where you
see that: it prints `[→ karel, not this machine]` next to every pending task that
belongs elsewhere.

Setting `machine` on a single-runner setup is optional; unset means "the only machine
there is", which is what every existing install keeps doing.

### Cloud — no machine at all

`> Machine: cloud` (**Cloud** on the card) runs the task in a Claude Code cloud session.
No runner ever runs it locally, not even one with no `machine` set. The one runner with
`"cloud": true` sends it (`src/cloud.js`, `src/cloudTick.js`):

1. **Start.** From the clone on its pushed base branch, the runner runs
   `claude --cloud "<prompt>" --model … --effort …` under `script`, because `--cloud`
   refuses to start without a terminal. The CLI prints the session's
   `claude.ai/code/session_…` link and exits within seconds. The link goes on the card's
   status line (`▶ Running on cloud …`) and to the phone. The runner goes back to its
   queue and never waits on the session.
2. **The prompt carries the skills.** Plugins don't load in a cloud session, so the prompt
   is `/todo NNN` plus the runner's own copy of the `todo` and `verify` skills, with three
   cloud rules: work on `todo/<stem>`, push it, open no PR (`gh` isn't signed in there).
   It's always the version the runner has, so there's nothing to copy into repos or upload
   to claude.ai. A copy in a repo's `.claude/skills/` would also shadow dev-kit's `/todo`
   in every local run.
3. **PR.** Once `origin/todo/<stem>` holds the task's `-DONE`/`-BLOCKED` file, a tick opens
   the PR. It's ready for a person in a push-to-main repo, or a draft in a `pullRequests`
   repo, where the review sweep takes over. A PR the session opened itself counts too. The
   card's line becomes `■ Finished on cloud · PR #N …`, and the session link stays on it.
4. **Done at the merge.** The file stays `-TODO` on the base branch while the PR is open.
   The merge brings the rename, and the reconcile sweep moves the card to Review with the
   Results. A WIP push without the rename doesn't count as a finish.

A task is sent once per version of its file. Editing the file sends it again, and a start
that fails twice in a row isn't retried. Only repos whose checks run without Hasura, a
database or the home network should get Cloud cards: the VM reaches GitHub and package
registries, nothing else. Sessions bill the account the runner is signed in to
(`claude auth status`), so turn `cloud` on for one runner on your own account.

## Pull-request repos

A repo in `pullRequests` never gets code from the runner on its base branch:

1. **Each task runs in its own worktree**, like every task — `~/.kanban-runner/worktrees/<repo>/<stem>`, on
   branch `todo/<stem>`, from a fresh `origin/main` (or from `origin/todo/<stem>` when an
   earlier attempt pushed one, or from the local branch when it holds that and more). The
   tree gets the clone's gitignored secrets and, with a
   lockfile, `npm ci`. The clone itself stays on `main`, so two sessions never share a tree.
   The task's herdr pane opens only after `npm ci` finishes. On a slow link that can take
   minutes, and the journal logs `npm ci in the new worktree` while it runs.
2. **When the session ends**, anything it left uncommitted is committed to its branch, the
   branch is pushed, and if the agent opened no PR the runner opens a **draft** (a ready
   PR that received leftovers outside the task folder is turned back into a draft and gets
   a new `codeReviewPr<N>` task). A session that changed only its task file is bookkeeping
   and lands on `main` directly; one that changed nothing is finished there as before. A
   session that ended off any branch is put back on `todo/<stem>` only when that keeps the
   branch's commits and adds none of another branch's; otherwise the worktree is left for
   a person.
3. **The task is done when its PR merges.** Until then the file stays `-TODO` on `main` and
   `listPending()` skips it: a PR carries a task when its branch is `todo/<stem>`, it says
   `Closes #NNN` for the file's own issue, it renames the task file to `-DONE`, or the
   session ended on it (a review or gate fix works on another PR's branch). Once merged, a
   task still `-TODO` on `main` is renamed `-DONE` there, unless the merge is older than
   the task file. So is a `codeReview` task that came in with the merge of the PR it
   names. The reconcile sweep closes the card.
4. **Every tick looks at the open PRs from `todo/*` and `claude/*`** (one `gh` round a
   minute). A draft older than 15 minutes with no `codeReview` task naming it gets
   `NNN-codeReviewPr<N>-TODO.md`; a ready, green PR without `hold` still open 30 minutes
   after its last check gets `NNN-mergeStuckPr<N>-TODO.md` — the merge job failed — once
   per green run, so a finished one that did not unstick it is not filed again. Red
   gates and refused merges are CI's to file (`NNN-gateFailurePr<N>-TODO.md`).
   A `todo/*` PR where a person asked for changes — a "Request changes" review, or an
   unresolved thread whose last human word came after the last push — gets
   `NNN-reworkPr<N>-TODO.md` listing each point (one GraphQL round a minute). Its session
   works on the PR's branch, pushes, and replies on every thread starting with
   `<!-- runner-reply -->`, so its own answers never count as feedback. Bot comments and
   resolved threads never count. It is filed once per review round: not while one for that
   PR still waits to run, and not again for feedback a task already listed.
5. **`> After: #78`** under the tier line holds a task until #78 is a merged PR or a closed
   issue: a session starts from `main` and cannot see work that has not landed.

Every session starts with `--settings ~/.kanban-runner/session.json`, which turns off
Claude's commit and PR attribution lines; commits carry the machine's git identity.

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
| `opus`   | 4.6, 4.8, 5, 5.5   | 5.5    | high           |
| `sonnet` | 4.6, 5, 5.5        | 5.5    | medium         |
| `haiku`  | 4.5                | 4.5    | low            |
| `gemini` | 3.8 (Flash, free)  | 3.8    | medium — only low/medium/high |

Add a version by putting its model id in that family's `versions`.

With no `Run with:` line at all (model **Auto** on the card), one `claude -p` call picks
a *family and effort*; the version is that family's latest. Any trouble falls back to
`Sonnet 5.5 / medium`. Fable is never auto-chosen — it bills usage credits, so it has to
be asked for by name.

Who makes that call is `config.json`'s `classifier`, written like a `Run with:` line:
`"classifier": "Opus / low"` is the default. The call reads ~500 characters and answers
two words, so the strongest model costs next to nothing and judges best. Gemini cannot be
the judge (it runs through aider), so naming it falls back to the default.

**Is the tier worth it?** `npm run tiers -- --days 30` prints one row per model / effort
from the `claude_usage` rows every run records: sessions, cards, sessions per card (above
1 means retries), median minutes and output tokens, and cost. Effort is the card's;
`auto` means the card left it unset. Cost reads 0 for a model LiteLLM has not priced yet.

Task-014 writes the line from the card's model/effort fields, so the tier is normally
chosen from the board rather than typed.

### Gemini — the free tier, via aider

`Run with: Gemini 3.8 / low` runs `aider --model gemini/gemini-3.8-flash
--reasoning-effort low` headless in the repo, not Claude (`src/aider.js`). aider has no
`/todo`, so it gets the task file read-only, edits and auto-commits; the runner's
autoFinish writes Results and the `-DONE` rename. Effort above `high` is capped there.
aider exits 0 even when the API rejected every call, so a litellm error in its output
counts as a failed run. Meant for simple tasks; its output is never read as a Claude usage limit.

Per machine, once: `uv tool install aider-chat` and `GEMINI_API_KEY=…` (free key from
aistudio.google.com) in `~/.config/kanban-runner.env`.

### Usage limits

There's no API for the runner to ask "how much session is left" ahead of time — it only
finds out when the CLI itself says the wall was hit. When a run's output shows that, the
runner stops: every repo sits idle until the reset time recorded in `src/state.js`'s
`cooldownUntil`. It does not retry at a cheaper tier, because the 5-hour and weekly walls
cover every model and effort alike, so a cheaper tier only meets the same wall within
seconds (server 026, tekdok 466). The reset moment comes from the CLI's own message — the
headless `| <epoch>`, or the `resets 12:10am (Europe/Tallinn)` wording an interactive/herdr-pane
run prints. `src/usage.js` turns that clock time and zone into the exact instant. Any zone
Intl knows counts, a bare `UTC` too. The day is whichever puts the time nearest now, so
12:10am read at 23:08 means 62 minutes from now, and the zone's offset is read at the reset
itself, so a DST change in between cannot shift it an hour. The runner waits one minute past
the stated minute. A reset that has already passed (the wall still up after it) is looked at
again in 15 minutes, not the same time tomorrow. Only a limit message with no time or an
unknown zone falls back to a fixed wait (5h session, 7 days weekly). Because the wall is the
account's state and not the task's fault, the attempt it consumed is given back, so a run that
started with almost no budget left doesn't count toward the 3-strikes skip. The log, `--check`
and the `Runner ⏳ usage limit` notification show that moment in the machine's local time,
with its zone (`08/11/2026, 00:11 EET`).

**The wall is one machine's, so its queue moves on** (klarity-claude-kit#12). Each machine
bills its own account: while the Mac waits out its reset, dell and karel are free. With
`"handOver": true`, every tick of the wait still preflights each repo, but only to give this
machine's waiting tasks back to Auto (`src/handover.js`): the card's machine is cleared, and a
bare `> Machine: mac` line goes from the file in one pushed
`chore(todo): hand 231, 234 to any runner — mac is at its usage limit until …` commit. The
first free runner claims each one as usual, and the phone gets `Runner ↪ handed over`. It keeps:

- a line with a reason in brackets, `> Machine: mac (the only one that can ssh renlog)`;
- a task whose pane still works, or whose worktree holds commits that are on no remote. That
  work resumes here after the reset. Other uncommitted work is parked in a stash first, as at
  any other ending;
- an Auto task it never started.

A runner that lost a claim asks the card again after ten minutes, so an Auto task it gave back
moves too. Leave `handOver` off where the board pins someone's cards to that one machine
(`windows`). Those cards wait for it.

## CLI flags

| Flag            | Effect                                              |
| --------------- | --------------------------------------------------- |
| `--check`       | Connected boards and any not yet onboarded, then per repo: path, current branch, task folder, dirty paths, open runner worktrees, blocked reason, pending tasks with attempt counts — plus whether the herdr server is up. Runs nothing |
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

[ntfy.sh](https://ntfy.sh), free. Set `NTFY_TOPIC` in the runner's environment to a
hard-to-guess topic and subscribe to it in the ntfy phone app. Optional: `NTFY_SERVER`
(self-hosted, default `https://ntfy.sh`) and `NTFY_TOKEN` (bearer token for a protected
topic). No topic means every notification is a silent no-op. A failed push is logged as
`notify failed: …` in the runner log. (Pushbullet was dropped: its API now answers
`pushbullet_pro_required`.)

| Title | Meaning |
| ----- | ------- |
| `Runner ✔` / `Runner ✘` | a task finished / exited non-zero |
| `Runner ⏸ needs you` | the agent is blocked on a prompt — answer it in the relay PWA |
| `Runner ⛔ blocked` / `Runner ▶ unblocked` | a repo stopped / resumed being processable |
| `Runner ⛔ task waiting` | a new task for this machine landed on origin while its repo is blocked |
| `Runner ↗ task on a branch` | work was left on a task branch, pushed, waiting for your merge |
| `Runner ⇄ PR` / `Runner ✘ → draft PR` | a pull-request repo's session ended on its PR — opened by the agent, or as a draft by the runner (after a failure, with what the session left) |
| `Runner ✘ branch did not ship` / `Runner ✘ did not land` / `Runner ✘ no worktree` | a task branch would not push, a push-to-main run's commits would not rebase or push onto the base branch, or its worktree would not open; the work stays in the worktree |
| `Runner ↪ handed over` | this machine is at its usage wall, so the listed tasks went back to Auto for another runner |
| `Runner ⚠ did not finish` | the agent stopped without renaming the file or committing |
| `Runner ⏭ stuck task` | two runs, no `-DONE` rename; the task is skipped and an `unstick` fixer task is filed |
| `Runner ＋ new repo` | a newly connected board was cloned, scaffolded and is now watched |
| `Runner － repo removed` | the repo's board was archived or deleted: no longer watched, clone deleted (or kept, with the reason) |
| `Runner ⚠ cannot onboard` | a connected board's repo would not clone or scaffold — said once, not every sweep |

## Files

| File | Role |
| ---- | ---- |
| `src/run.js`     | tick loop, one task per tick, `--check` |
| `src/repo.js`    | git preflight: dirt classification, branch, fetch/pull |
| `src/queue.js`   | task folder → pending list, attempt-limited pick |
| `src/unstick.js` | the fixer task filed for a task that ran twice without finishing |
| `src/state.js`   | `~/.kanban-runner/state.json`: blocked reasons, attempt counts, how the last attempt ended |
| `src/retry.js`   | the `/todo` prompt: bare on attempt 1, plus the last ending on a retry |
| `src/herdr.js`   | run Claude in a herdr pane, wait out blocks |
| `src/classify.js`| model + effort tier for a task file |
| `src/pricing.js` | LiteLLM price list → `claude_model_pricing` rows |
| `src/sessionUsage.js` | read a run's transcript → one `claude_usage` row |
| `src/sessionLink.js` | the run's claude.ai/code link, read from its transcript → the status line |
| `src/status.js`  | the run's one live status comment on its card, edited as it goes |
| `src/selfUpdate.js` | fast-forward the runner's own checkout so both machines run the same code |
| `src/secrets.js` | gitignored secrets → the peers, on the sweep's clock; `npm run sync-secrets` by hand |
| `src/onboard.js` | connected boards → clones, `config.json` entries, the peer machine. The daemon calls it on a timer |
| `src/offboard.js` | archived or deleted boards → `config.json` entry and clone removed, secrets kept for a restore |
| `src/waiting.js` | tasks on origin that a blocked clone cannot see yet, so the human hears about each one |
| `src/scaffold.js`| one clone → plugin enabled, task folder, CLAUDE.md, dependencies |
| `src/trust.js`   | pre-answer Claude's folder-trust dialog in `~/.claude.json` |
| `src/followup.js`| new follow-up file → GitHub issue → Backlog card, file renamed to the issue number |
| `src/screenshots.js` | a UI task's screenshots → attachments on its card |
| `src/claim.js`   | claim an Auto (unaddressed) task on its Kanban card before running it |
| `src/handover.js`| at the usage wall, this machine's waiting tasks back to Auto for a free runner |
| `src/worktree.js`| a task's own branch and worktree, removing it again; for pull-request repos, shipping it as a PR |
| `src/land.js`    | push-to-main repos: land a run's commits on the base branch from its worktree, catch the clone up |
| `src/sweep.js`   | worktrees and branches a run left behind, put away once their task is over |
| `src/pr.js`      | pull-request repos: what is in flight, finishing merged tasks, the review / stuck-merge sweep, `> After:` |
| `src/rework.js`  | pull-request repos: a person's review comes back as a `reworkPr<N>` task |
| `src/notify.js`  | ntfy.sh |

## Notes

- Requires Node ≥ 20 and `claude` on `PATH`. No npm dependencies. `useHerdr` also
  needs `herdr` on `PATH` and `dev.herdr.server` running.
- A repo whose `CLAUDE.md` forbids committing will complete the task but leave HEAD
  unchanged — the log says so and no push is attempted.
- `test/smoke.test.js` runs one real `--once` tick: a scratch origin and clone, one
  `-TODO` task, and a fake `claude` that renames it and commits. If pickup or landing
  breaks, `npm test` fails here before the change reaches the machines.
