> Run with: Sonnet 5.5 / medium
> Machine: windows

# Link new device

## Original Requirement

[NEVER REMOVE]

I want to link herdr to new phone. Karel2 win machine. Give me 2 times it so also I can add to laptop.

_From Kanban card `46c9653f-88ce-431d-94f4-dddf058e3ef4`, moved to the agent list._

_GitHub issue #6 — end the commit subject with `(#6)`._

## Results

**Summary** — Generated the phone pairing link for herdr on karel2 (the win machine) by running the
Herdr Mobile Relay's own `relay/setup-link.sh` (the "Show Phone Setup QR" plugin action) with
`HERDR_RELAY_ENV` pointing at the installed service's `relay.env`. It was run twice; both runs give
the same link, because the link carries the relay token and each scan pairs one device within
10 minutes. So one link serves both the new phone and the laptop. The link is **not** written here:
it holds the relay token and this file is pushed. The link was given in the run's final message.
To print it again: herdr command palette → "Herdr Mobile Relay: Show Phone Setup QR".

**Files changed** — this task file only (renamed to `-DONE.md`).

**Verification** — `setup-link.sh` exited cleanly with a QR code and URLs for label `karel2`. Not
verified: an actual pairing from a device.

**Deviations** — The link is shown in the chat reply, not in this file (secret).
