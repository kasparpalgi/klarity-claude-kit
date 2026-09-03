# kanban-runner

Move a card to **TODO** on the Kanban → Claude Code writes `doc/todo/NNN-*.md` in the
matching repo and runs `/todo NNN` against it. The card comes back as **Review** (with the
file name and commit SHA in a comment) or **Blocked** (with the tail of the output).

```
Kanban card ──move to TODO──▶ runner polls Hasura
                                   │  claim: TODO → Doing (atomic, so re-moves are safe)
                                   │  write doc/todo/NNN-slug-TODO.md
                                   │  claude -p "/todo NNN" --model … --effort …
                                   ▼
                          card → Review + comment      (exit 0)
                          card → Blocked + last 30 lines (exit ≠ 0)
```

> **Personal tooling, not the product.** This needs the Kanban's _global_ admin secret, so
> it can only ever run on a machine you own, for boards you own. The multi-user path is
> todzz.eu writing the task file server-side (`doc/todo/014`), after which this drops Hasura
> and just watches the local clone (`015`).

**It polls; it never listens.** No public endpoint, no tunnel, no webhook secret, no Hasura
event trigger. The Mac reaches out to Hasura, so the whole thing works from behind NAT.

**It changes nothing in the Kanban's database.** Columns are `lists` rows, the claim is a
`list_id` update, the outcome is a `comments` row. Zero migrations.

## Setup

```bash
cd plugins/dev-kit/runner
cp config.example.json config.json     # edit endpoint + repo map
export HASURA_ADMIN_SECRET=…           # the Kanban's admin secret
npm run check                          # what would it do? runs nothing
npm start
```

`config.json` is gitignored — it names your local clone paths.

| Key           | Meaning                                                                     |
| ------------- | --------------------------------------------------------------------------- |
| `endpoint`    | Kanban Hasura GraphQL URL                                                   |
| `pollSeconds` | how often to look (default 20)                                              |
| `lists`       | column names on the board: `todo`, `doing`, `review`, `blocked`             |
| `repos`       | `"owner/repo"` (as connected on the board) → local clone path; `~/` is fine |

**`repos` is required and is the security boundary.** The admin secret is global — on the
shared instance it can see all 49 users' boards — so the query is scoped to these
`owner/repo` names. An empty `repos` is a startup error, not an "everything" wildcard.

**`lists` almost certainly needs editing.** Column names are free text and boards use
whatever their owner typed: `Sooner`, `Töös`, `in Arbeit`. Run `npm run check` and it prints
any column it cannot find on each board.

## Connecting a new project

Each entry in `repos` links one Kanban board to one local git clone. To add a project:

**1. Find the `owner/repo` key.**
Open the board in todzz.eu → Board settings → GitHub integration. The repo name shown
there (e.g. `kasparpalgi/my-new-app`) is the key. It must match exactly — the runner
uses it to filter the admin-secret query to only your boards.

**2. Add the entry to `config.json`:**

```json
"repos": {
  "kasparpalgi/my-new-app": "~/Documents/GitHub/my-new-app"
}
```

`~/` is expanded at runtime, so relative-to-home paths work fine.

**3. Check the column names.**
The runner needs four columns on every connected board: a TODO inbox, a Doing/in-progress
column, a Review column, and a Blocked column. Their names are free text — boards use
whatever the owner typed. The `lists` key in `config.json` is shared across all boards,
so use whichever names your boards have in common (or rename the columns to match).

```json
"lists": {
  "todo":    "TODO",
  "doing":   "Doing",
  "review":  "Review",
  "blocked": "Blocked"
}
```

**4. Verify:**

```bash
HASURA_ADMIN_SECRET=… npm run check
```

Cards in your TODO column print with the local path. Missing columns are listed — create
them on the board (or rename existing ones) and re-run until clean.

**5. Restart the runner** so it picks up the new config:

```bash
launchctl kickstart -k gui/$(id -u)/eu.todzz.kanban-runner
# or, if running manually: Ctrl-C and npm start
```

**Task file location.** The runner writes to `.claude/todo/` if that directory exists in
the repo, otherwise `doc/todo/`. Both are auto-created on first use. Match whichever
directory your repo's `/todo` skill reads from.

---

## Model & effort

The card decides, if it says so: a line like `Run with: opus` (or `sonnet` / `haiku`)
anywhere in the description. Otherwise a `claude -p --model haiku` call classifies it into
one of the three tiers, defaulting to `Sonnet 5 / medium` if that call fails. The chosen
tier is written as the task file's `> Run with:` line, which is what `/todo` expects.

## Notes

- **One card at a time**, enforced in the query (`limit: 1`), not just by the loop — a real
  column can hold ninety cards, and each one is a Claude session. Cards left in TODO are
  picked up on later ticks.
- **Card bodies are HTML.** The Kanban's editor stores `<p>…</p>`; `toText()` converts it
  before it reaches the task file. Plain-text and voice cards pass through untouched.
- **Idempotent.** The claim is `UPDATE … WHERE list_id = <TODO>`; a second move while the
  card is in Doing affects zero rows and is ignored.
- **Credentials live here, never in the Kanban app.** The admin secret is an env var on
  this machine; repo push rights are the local git config.
- Requires Node ≥ 20 (built-in `fetch`) and `claude` on `PATH`. No npm dependencies.

## Auto-start with launchd (macOS)

Keep the runner alive across reboots and logins with a launchd user agent.

```bash
# 1. Copy and edit the template
cp launchd.plist.example ~/Library/LaunchAgents/eu.todzz.kanban-runner.plist
# Replace every YOUR_NAME and REPLACE_WITH_YOUR_SECRET in the plist.
# Also verify: which node  (update ProgramArguments[0] if different)

# 2. Load it
launchctl load ~/Library/LaunchAgents/eu.todzz.kanban-runner.plist

# 3. Start immediately (without waiting for next login)
launchctl kickstart -k gui/$(id -u)/eu.todzz.kanban-runner
```

**Tail the log:**

```bash
tail -f ~/Library/Logs/kanban-runner.log
```

**Stop / disable:**

```bash
launchctl unload ~/Library/LaunchAgents/eu.todzz.kanban-runner.plist
```

**Restart after editing `config.json`:**

```bash
launchctl kickstart -k gui/$(id -u)/eu.todzz.kanban-runner
```

The `-k` flag kills any running instance first so restarts are clean.
The plist file (with your secret) is not committed — it lives only in `~/Library/LaunchAgents/`.
