> Run with: Opus 5.5 / high
> Machine: mac

# 007 not fixed

## Original Requirement

[NEVER REMOVE]

Started new session on ostutark and in herdr I see:

# \
021-createUserSignupAnd

task-021 · claude @karel2

**•••⚙**

## Conversation

Branch unverified: saved history may not reflect the current branch.

**Conversation**Full history

Search loaded conversation

**Load older turns**

No user prompts or agent answers are recorded in the available history.

No user prompts or agent answers are recorded in the available history.

_From Kanban card `e1b26f21-c8d0-43a3-82de-0fb4aa54fed3`, moved to the agent list._

_GitHub issue #8 — end the commit subject with `(#8)`._

## Results

**Summary** — Nothing broken, and nothing to build: both views already exist. Since relay
0.23.0 the herdr phone app opens an agent in **Conversation** view: the short summary you now see.
The full Claude Code output is still there, one tap away:

- **Terminal icon** (a box with `>_`, top right, left of the folder and `•••`): the live
  Claude Code pane, the same as before. The **book icon** in the terminal header goes back to the short view.
- **Full history** (the button beside Conversation): every message and tool call.
- **Settings → Agents → Default View → Terminal**: open every agent on the full output. The
  short view stays one tap away through the book icon.

The two messages in the card are not errors either. The app shows **"Branch unverified"** on
every Claude pane (relay `conversation_live.go`: only Kimi agents are marked
`active_branch`). **"No user prompts or agent answers…"** means the newest page of the
transcript held only tool calls and no text. **Load older turns** or the terminal shows the rest.

**Files changed** — `plugins/dev-kit/runner/README.md` (the Visible-mode note now explains the
view toggle and these two messages); this task file (renamed).

**Verification** — Read the relay source at the installed revision `7fb48b2` (0.25.1):
`App.svelte` header buttons (Terminal view / Conversation history), `ConversationHistory.svelte`
(the mode buttons and the empty-history message), `conversation.ts` `conversationEntries`, and
`agent-view.ts` `effectiveAgentView`. `npm test` was not run: only the README changed. The toggle
was not tried on a phone.

**Deviations** — No code change. The runner cannot pick the phone's view: it is a per-device
setting in the app.
