> Run with: Opus 5.5 / high
> Machine: dell

# Herdr

## Original Requirement

[NEVER REMOVE]

New sessions in herdr doesn't show me anymore what's going on - I see:

 

**513-duringTheCallIssues**Nov 12, 2026 at 9:57 PM**Speak**

Root causes found for all three. Writing the plan into the task file, then implementing.

_From Kanban card `90c98771-a8f6-4504-9083-8321282a725d`, moved to the agent list._

_GitHub issue #7 — end the commit subject with `(#7)`._

## Results

**Summary** — Nothing in the runner broke; the phone app changed. The herdr mobile relay on this
machine auto-upgraded to 0.25.1 today (`~/herdr-upgrade.log`, 13:48). Since relay 0.23.0 the app
opens a Claude pane in **Conversation** view by default: only the user prompt and the latest agent
answer, with a **Speak** (read-aloud) button. Tool calls and intermediate messages are hidden.
That matches what the card showed: title, time, "Speak", one answer line. It is a per-device
setting in the app's local storage (`frontend/src/lib/preferences.ts` defaults to `conversation`).
The runner cannot set it.

What you need to do (on the phone, once):

- **Settings → Agents → Default View → Terminal**: every agent opens on the live pane again, or
- in an open agent, tap **Full history**: every message and tool call. The app remembers this on
  the device, for all panes.

The per-pane "Default View" in the agent's Manage dialog will not help, because each run is a new
`task-NNN` pane with a new identity.

**Files changed** — `plugins/dev-kit/runner/README.md` (a note in "Visible mode"); this task file
(renamed).

**Verification** — Read the relay 0.25.1 source and CHANGELOG at the installed checkout (commit
`91d70e7`): `SettingsView.svelte` "Default View", `agent-view.ts` `effectiveAgentView`,
`ConversationHistory.svelte` "Full history". `npm test` was not run: only the README changed. The
setting was not tried on a phone.

**Deviations** — No code change. Ends as BLOCKED because the fix is a setting only you can change
on your phone.
