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
