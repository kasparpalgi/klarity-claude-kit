> Run with: Opus 5.5 / high
> Machine: dell

# Resize messy issue

## Original Requirement

[NEVER REMOVE]

<https://github.com/0cv/herdr-mobile-relay/issues/60#issuecomment-6784170892>

has response:

## **Recurrence triage — 2026-11-11**

The reported desktop flicker / mobile terminal desynchronization matches the known TUI `Resize Session` limitation tracked here. In the current client, the preference is device-local and defaults to **on** when unset. A phone lease changes the PTY size directly, while Herdr's TUI grid remains at its layout size; the desktop/SSH view can therefore garble, and a desktop resize can be fought by the next lease renewal. That shared-size mismatch can make the Relay screen appear out of sync too. This is not evidence of a relay transport outage; the running relay health check is ready.

I detached the temporary Termix Herdr SSH client I used for integration verification. I sent no input through it and did not create or close any Herdr session; the Herdr server and Mobile Relay service remain running.

**Immediate mitigation:** on each controller phone using Terminal, open **Settings → Terminal → Resize Session** and switch it **off while connected**. The client sends immediate releases for all pane-size leases owned by that device. Keep **Lease Terminal Height** off. This preference is stored in each phone/browser, so it cannot be changed remotely from the relay host. Once disabled, if a pane still looks garbled, resize its desktop pane once; if flicker persists after the feature is off, investigate as a separate issue.

---

Also, I see there's update available so update herdr to the latest on all machines where it is not running. If runner running, must wait it to finish!!!!

_From Kanban card `43d11c46-fa77-4ce2-94b2-9bf9d481217c`, moved to the agent list._

_GitHub issue #4 — end the commit subject with `(#4)`._

## Results

**Summary** — The resize/flicker part needed no fix: the user changed the phone's text
size from small to regular and the panes now line up ("just upgrade"). Then herdr and the
Herdr Mobile Relay were upgraded on every runner machine, and only while its runner was
not inside a run:

| Machine        | herdr          | relay plugin    | When                                                  |
| -------------- | -------------- | --------------- | ----------------------------------------------------- |
| winwsl/karel2  | 0.9.1 → 0.9.5  | 0.23.5 → 0.25.1 | 13:35, verified                                        |
| mac            | 0.8.2 → 0.9.5  | 0.20.7 → 0.25.1 | 13:45, verified (needed a full server stop, see below) |
| karel          | 0.9.1 → 0.9.5  | 0.21.3 → 0.25.1 | pending — waits for task-434 (tektok-app) to finish   |
| servo/dell     | 0.9.1 → 0.9.5  | 0.22.4 → 0.25.1 | pending — waits for this run (task-004) to finish     |

How it waits: `~/herdr-upgrade.sh` runs on each Linux machine as the transient user unit
`herdr-upgrade` (it survives the herdr restart). It counts the runner as busy when a
`task-*` tab is working/blocked, or when the runner has a `claude`/`npm`/`herdr agent`
child. It needs 3 idle checks 20 s apart. Then it stops `kanban-runner` and checks again
(if a task slipped in, it starts the runner back up and waits). Then it runs `herdr update`
and `herdr integration install claude`, restarts `herdr-server`, runs
`HERDR_MOBILE_RELAY_NO_AUTO_SETUP=1 herdr plugin install 0cv/herdr-mobile-relay --yes`,
restarts the relay, and starts the runner. It logs to `~/herdr-upgrade.log`.

- The mac's 0.8.2 server came before endpoint generation 1, so `herdr update` refused
  ("Stop running Herdr sessions when ready"). Done by hand: `launchctl bootout` of the
  runner and `dev.herdr.server`, then `herdr update`, then bootstrap again. The first
  minute after the restart, the server restored sessions and `agent list` hung. It has
  answered at once since then. Session restore brought back the finished task-005 pane
  as `blocked`; it is harmless.
- A plain restart through systemd/launchd was chosen over `--handoff`. Handoff is
  experimental, and both servers run under supervisors that restart them. The cost:
  idle panes (shells, finished task panes) get restarted and restored, not kept live.

**Files changed** — `doc/todo/004-resizeMessyIssue-TODO.md` → `-DONE.md` (this Results
section). No repo code changed. `~/herdr-upgrade.sh` was added on servo, karel, mac and
winwsl (outside the repo).

**Verification**
- winwsl: `herdr status` shows client and server both 0.9.5. The relay manifest says
  0.25.1. `kanban-runner`, `herdr-server` and `herdr-mobile-relay` are active, and the
  relay's Cloudflare precheck passes.
- mac: client and server 0.9.5, endpoint generation 1. The relay runs the 0.25.1 darwin
  build. The runner logged `watching 20 repo(s)` at 13:45:16.
- karel, servo: the `herdr-upgrade` unit is active and waiting. Not verified in this
  session. Check with `tail ~/herdr-upgrade.log`, which ends in `done` once it has run.

**Deviations** — No upgrade of the native Windows host; herdr runs in its WSL (winwsl).
The phones may show "update available" for the app once their relay is on 0.25.1;
accepting it on the phone is expected.
