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

## Setup

```bash
cd plugins/dev-kit/runner
cp config.example.json config.json     # edit the repo map
npm run check                          # prints repos + any pending TODO files
npm start
```

`config.json` is gitignored.

| Key           | Meaning                                                       |
| ------------- | ------------------------------------------------------------- |
| `pollSeconds` | how often to pull (default 60)                                |
| `repos`       | `"owner/repo"` → local clone path; `~/` is expanded at runtime |

## How it works

Each tick (one per `pollSeconds`):

1. For each configured repo, check for a dirty working tree → skip if dirty (never forced).
2. `git pull --ff-only` → skip the repo if the branch has diverged.
3. Find the lowest `NNN-*-TODO.md` where no `NNN-*-DONE.md` exists.
4. Read the `> Run with:` frontmatter line (written by task-014). Classify with a
   cheap Claude call if the line is missing; default to `Sonnet 5 / medium` on failure.
5. Run `claude -p "/todo NNN" --model … --effort … --dangerously-skip-permissions`.
6. If HEAD advanced (i.e. `/todo` committed), push to `origin main`.

**One task per tick.** The loop returns after the first task it runs, so repos queue
naturally.

## Model & effort

The task file's first line decides: `> Run with: Opus 5 / high` (or `sonnet` / `haiku`).
Otherwise a haiku classifier call picks the tier. See `classify.js`.

## Notes

- Requires Node ≥ 20 and `claude` on `PATH`. No npm dependencies.
- A repo whose `CLAUDE.md` forbids committing will complete the task but leave HEAD
  unchanged — the log says so and no push is attempted.
- `--check` prints each repo path and any pending task file; runs nothing.

## Auto-start with launchd (macOS)

```bash
cp launchd.plist.example ~/Library/LaunchAgents/eu.todzz.kanban-runner.plist
# Edit: WorkingDirectory, PATH, config path
launchctl load ~/Library/LaunchAgents/eu.todzz.kanban-runner.plist
launchctl kickstart -k gui/$(id -u)/eu.todzz.kanban-runner
tail -f ~/Library/Logs/kanban-runner.log
```
