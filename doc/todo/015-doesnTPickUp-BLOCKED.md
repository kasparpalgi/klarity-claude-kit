# doesn't pick up on karel2

## Original Requirement

[NEVER REMOVE]

ostutark_v2 repo shall start

_From Kanban card `7a6ce26b-b30f-4941-a88c-2766afccba7b`, moved to the agent list._

_GitHub issue #15 — end the commit subject with `(#15)`._


## Results

**Summary** — `ostutark_v2` is not stuck on the Mac. Its one queued task, `doc/todo/022-bince-TODO.md`
(origin/main `cfd22fd`), says `> Machine: windows`. The Mac's `--check` lists it as
`[→ windows, not this machine]`, so skipping it is correct. `windows` is a known runner id in the
Mac's `machines` list, so this is not the "addressed to nobody" case from #14. Only karel2 can
take it, and karel2 is where it fails.

I could not look at karel2: `ssh winwsl` gives `No route to host` (192.168.0.177:9113). The Windows PC
or its WSL2 network is off or has changed address. That is the most likely reason nothing starts.

**What you need to do on karel2** (I can't, it is unreachable)
1. Power it on and check `ssh winwsl` from the Mac. WSL2 gets a new IP when Windows restarts.
2. In its `runner/config.json`, `repos` needs `"kasparpalgi/ostutark_v2": "~/Documents/GitHub/ostutark_v2"`,
   and the clone has to exist there. The Mac has it, but karel2 may not.
3. `machine` must include `windows`: `["windows", "win", "karel2"]`, as in `runner/README.md`.
4. `node src/run.js --check` on karel2 should list `022-bince-TODO.md` as pending for this machine.

To start it now without karel2, delete the `> Machine: windows` line from 022. It then runs on Auto, and the Mac takes it.

**Files changed** — this task file only (renamed to `-BLOCKED.md`). No runner code change: the Mac
behaved as designed.

**Verification** — Mac `node src/run.js --check` against the live config (see above). The karel2
config and logs are unchecked because the host is unreachable.

**Deviations** — The card held one line, so I treated it as "find out why ostutark_v2 doesn't start on karel2".
I did not move 022 off `windows`, because the owner chose that machine.
