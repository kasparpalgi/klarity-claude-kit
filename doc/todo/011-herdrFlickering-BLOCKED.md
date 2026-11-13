> Run with: Opus 5.5 / xhigh

# herdr flickering

## Original Requirement

[NEVER REMOVE]

sometimes on browser, also send me links to try on herdr native app to connect on y android - currently browser

see also why todo tasks from the kanban board doesnot pick up

_From Kanban card `ccefe8f0-4729-415c-9e5a-7f24feec3a0a`._

## Results

**Summary**

*Flicker.* The runner does not cause it. The phone app redials its relays, and each redial can
resize the pane.

- The relay logs on karel and dell show the same bursts, at the same second. The phone drops
  every relay and redials every 1–3 s: 12/11 21:50 and 22:12, 13/11 01:20–01:23 (about 17
  redials in 90 s), and 20:09. Both machines at once means the cause is on the phone or its
  network, not one machine.
- In relay 0.25.1 (`frontend/src/lib/security.ts` `onNetworkChange`, `store.ts`
  `revalidateConnections`), the app listens for Chrome's `navigator.connection` change event,
  which iOS Safari does not have. On each one it pings every relay and redials any relay that
  sends nothing for 2 s. Each redial reloads the agent list and the open terminal.
- **Resize Session** is on by default again since 0.23.0: `readTerminalResizeSession` returns
  true when nothing is saved. 0.22.8 had made it opt-in after your issue #60. A disconnect
  releases the pane size at once (`ReleaseClient`), and the reconnect leases it again. That
  is two resizes per redial, and Claude repaints the whole screen each time.
- Not Claude's own renderer: karel and the Mac set `"tui": "fullscreen"`, the flicker-free
  renderer. The karel pane shows 0 scrollback rows, so it is on the alternate screen. Dell has
  no setting, but its Claude first ran on 2026-10-01, so it most likely defaults to fullscreen too.
- Not the runner: `src/herdr.js` only lists herdr state, and opens and closes one tab per run.

*Native Android apps.*

- **Herdr**, the official app: <https://play.google.com/store/apps/details?id=dev.herdr.app>.
  It works only with herdr-core ("Herdr TUI isn't supported", <https://herdr.dev/mobile/>).
  Our machines run the Herdr TUI 0.9.5 and have no `hc`, so runner tasks will not show in it.
  Its **Try the demo** button shows the app without any setup. Backlog 013 moves the runner
  to herdr-core, in case you prefer this app.
- **herdr-android**, third party, MIT, APK v0.1.595 from 8 Nov:
  <https://github.com/makefunstuff/herdr-android/releases/latest>. It works with the Herdr TUI
  over SSH. Copy the app's public key (Settings) into `~/.ssh/authorized_keys`, then add karel
  or the Mac by its Tailscale name. Both have Tailscale and sshd. Dell has no Tailscale: add it
  with **Connect through** karel. Its `herdr-push pair` QR route runs their Python script on
  the machine, so I did not run it.
- Checked and not recommended: Flocket and Herdr Anywhere (herdr-core only), benkraus/herdr-mobile
  (no APK, and it needs its own relay), ColliePWA (another browser app).

*Tasks not picking up.* Fixed in #12 (`b77a997`, `01a7d94`). This task shows it working: the
Mac handed 011 over at 22:46:13, and karel started it at 22:46:47.

**What you need to do** (why BLOCKED)

1. On the phone: **Settings → Terminal → Resize Session → off**. If it still flickers, note the
   time. The relay log shows whether it was a redial burst.
2. Try the two apps above.
3. If you agree, report the redial loop upstream. I did not post it for you. Draft:
   > **Android: network-change revalidation redials every relay every 1–3 s.** Relay 0.25.1,
   > Chrome on Android, Cloudflare tunnel. Two relays log `client connected`/`disconnected`
   > every 1–3 s for up to 90 s, at the same second on both (2026-11-13 01:20–01:23 EET).
   > `onNetworkChange` → `revalidateConnections(2000)` redials any relay that is silent for 2 s.
   > With Resize Session on, each redial also releases and re-leases the pane size, so the agent
   > repaints twice. Could the change event be debounced, or skipped when a message arrived
   > in the last few seconds?
4. Triage Backlog 013.

**Files changed**

- modified `plugins/dev-kit/runner/README.md`: two paragraphs in *Visible mode*, on flicker and
  on the native apps
- created `doc/todo/013-runnerOnHerdrCore.md`, a Backlog follow-up
- renamed this file to `-BLOCKED.md`

**Verification**

- Read the relay v0.25.1 source (tag `9f4a5ed`) and CHANGELOG. Read `journalctl --user -u
  herdr-mobile-relay` on karel and dell. Checked `tui`, Tailscale, sshd and `hc` on all three
  machines over SSH. Read the Play Store listing, herdr.dev/mobile and the herdr-android guide.
- `npm test`: 242 tests pass. Only the README changed. No phone test, and the apps were not installed.

**Deviations** — No runner code change: the flicker comes from the phone app. Ends BLOCKED,
because the setting, the app trial and the upstream report are yours to do.
