> Run with: Opus 5.5 / high

# Runner panes in herdr-core, so the official Herdr app sees them

## Original Requirement

[NEVER REMOVE]

sometimes on browser, also send me links to try on herdr native app to connect on y android - currently browser

_Split out of #11 for triage. Do it only if the official app wins once you have tried it._

## Why

The official Herdr app ([Google Play](https://play.google.com/store/apps/details?id=dev.herdr.app),
[herdr.dev/mobile](https://herdr.dev/mobile/)) connects over SSH to herdr-core (`hc`). It does
not support the Herdr TUI, and watching from the phone never resizes a pane on the computer.
The runner opens every task in the Herdr TUI server (`herdr tab create`, `herdr agent start`,
`herdr agent wait` in `src/herdr.js`), so runs never show in that app. No machine has `hc` yet.

## Task

1. Install herdr-core on one machine and check that `hc` can open a tab in a folder, start
   `claude` with arguments, send it a prompt and wait for it to go idle or blocked.
2. Add an opt-in `herdrCore` config key. The TUI path stays the default and the fallback.
3. Relay 0.25.0+ can run a second relay for herdr-core, so the browser app keeps showing runs.
