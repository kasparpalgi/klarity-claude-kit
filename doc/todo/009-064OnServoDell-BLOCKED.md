> Run with: Opus 5.5 / high
> Machine: windows

# 064 on servo dell

## Original Requirement

[NEVER REMOVE]

why runner doesn't pick up on tektok-app repo

_From Kanban card `58ac3501-5d23-4477-a12c-d99fdd38bf92`, moved to the agent list._

_GitHub issue #9 — end the commit subject with `(#9)`._

## Results

**Summary** — Looked at the dell runner (hostname `servo`) over ssh. Two findings:

1. **tektok-app is not stuck on dell.** `kanban-runner.service` is up (pid 2724193, current
   `main` 579fa51). Today it claimed and ran 520, 523 and 526 in `mytekdok/tektok-app`, and
   skipped 517/519/524 only because another machine had claimed them. Every `-TODO.md` still
   in that repo is addressed somewhere else, so dell is right to leave them:
   `527-iosCallScreen` → `Machine: mac`; 343, 409, 447, 474, 505 → `Machine: manual`
   (409's line sits inside its quoted original requirement, and the parser still finds it).
2. **Task 064 belongs to `kasparpalgi/ezysmart-web`, not tektok-app**:
   `.claude/todo/064-moveFromHetznerThe-TODO.md`, queued at 20:05. It is waiting because
   dell's clone `~/Documents/ezy/ezysmart-web` has had uncommitted work in it since 17:49.
   It wasn't a runner task, because no worktree was involved; it looks like an interactive
   063.2 session:
   - `worker/src/index.ts`: the CORS `allowHeaders` gain `sentry-trace` and `baggage`, plus `maxAge: 86400`
     ("found in production in 063.2")
   - `worker/src/index.spec.ts`: a preflight test for those headers
   - `scratch/shop.png`: untracked screenshot

   Dirt outside the task folder could be the user's own work, so the runner skips the repo
   by design (see Guards in `runner/README.md`). It also sent both notifications:
   `⛔ blocked` (17:53) and `⛔ task waiting` for 064 (20:06:30, `src/run.js:279`).
   No runner bug.

Side notes, both harmless: the herdr pane `task-526` is still open (status `done`) in its
deleted worktree. Dell's `state.json` also still has `"tektok-app/tektok-app": "missing"`
in `blocked`. That's the repo's pre-rename name, which is no longer in config, so nothing
reads it.

**What a human has to do** — the work in the clone is not mine to commit to `main` or
throw away. On dell:

```bash
cd ~/Documents/ezy/ezysmart-web
# keep it (it looks finished and has a test):
git add worker/src && git commit -m "fix(worker): allow Sentry trace headers in CORS preflight" && git pull --rebase && git push
rm -rf scratch        # or add scratch/ to .gitignore
# or throw it away: git checkout -- worker/src && rm -rf scratch
```

Once the tree is clean, the next tick sends `▶ unblocked` and starts 064.

**Files changed** — this task file only (results + rename). No runner code changed.

**Verification** — read-only checks over ssh on dell: `journalctl --user -u kanban-runner`,
`git status` of both clones, `herdr agent list`, `config.json` machine and repos (read only,
not printed in full). No code changed, so there was nothing to run `npm test` against.

**Deviations** — The card says tektok-app, but 064 is in ezysmart-web. I answered the
tektok question and also explained 064.
