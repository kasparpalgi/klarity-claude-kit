/**
 * Run Claude inside a herdr pane instead of as a bare child of the daemon, so
 * the agent is visible — and answerable — from the phone at herdr.servicehost.io.
 */

import { execFile } from "node:child_process";
import { promisify } from "node:util";

const exec = promisify(execFile);
const SETTLED = ["--until", "idle", "--until", "done", "--until", "blocked"];
const LEAVING = ["--until", "working", "--until", "idle", "--until", "done"];

/**
 * Read HERDR_BIN per call, not at import: the tests set it after importing, and
 * a module-level read sent them to the real herdr, whose reap() closed every
 * live `task-*` tab — killing the very agent that ran `npm test` (task 044).
 */
async function raw(args, timeout = 20000) {
  const bin = process.env.HERDR_BIN ?? "herdr";
  const { stdout } = await exec(bin, args, { timeout, maxBuffer: 8 << 20 });
  return stdout;
}

async function hx(args, timeout = 20000) {
  return JSON.parse(await raw(args, timeout)).result;
}

/** Cheap liveness probe. False means fall back to the headless path. */
export async function herdrUp() {
  try {
    await hx(["agent", "list"], 5000);
    return true;
  } catch {
    return false;
  }
}

/** An agent mid-turn, or waiting on a human. Its pane is somebody's work. */
const LIVE = new Set(["working", "blocked"]);

/**
 * A finished run now leaves its pane open at the shell prompt so a human can
 * type a follow-up and close it themselves. So before each run we close any
 * leftover `task-*` tab from a previous run. Key off the tab *label*, not the
 * agent list: a finished agent drops out of `agent list`, but its tab lingers —
 * only `tab list` still sees it. A *live* tab is never closed: a runner that
 * restarted mid-run (a self-update, or by hand) used to reap the agent it had
 * just started, and its next pick re-ran the same task from a stash.
 */
async function reap() {
  const { tabs } = await hx(["tab", "list"]);
  for (const t of tabs) {
    if (t.label?.startsWith("task-") && !LIVE.has(t.agent_status))
      await hx(["tab", "close", t.tab_id]).catch(() => {});
  }
}

/**
 * True while a `name` tab is still working or blocked — a run this process did
 * not start (it restarted since) or no longer waits on (taskMinutes ran out).
 * Picking that task again would start a second agent on the same files.
 */
export async function paneLive(name) {
  try {
    const { tabs } = await hx(["tab", "list"], 5000);
    return tabs.some((t) => t.label === name && LIVE.has(t.agent_status));
  } catch {
    return false;
  }
}

async function ensureWorkspace(cwd) {
  const { workspaces } = await hx(["workspace", "list"]);
  if (workspaces.length) return workspaces[0].workspace_id;
  // The very first workspace after a cold server start can take minutes.
  const r = await hx(
    ["workspace", "create", "--cwd", cwd, "--label", "runner", "--no-focus"],
    180000,
  );
  return r.workspace.workspace_id;
}

/**
 * A blocked agent refuses `recent-unwrapped` ("cannot read N lines while it is
 * blocked") — which is exactly when we most need the pane, to show the phone
 * what it is asking. Fall back to the visible screen, which always reads.
 */
const readPane = async (name) => {
  let last = "";
  for (const src of ["recent-unwrapped", "visible"]) {
    try {
      return await raw([
        "agent",
        "read",
        name,
        "--source",
        src,
        "--lines",
        "400",
      ]);
    } catch (err) {
      last = err.message;
    }
  }
  return `herdr read failed: ${last}`;
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Claude ends its turn to wait on a background job — the footer then reads
 * "2 shells, 1 monitor" — and herdr calls that idle. It is not finished: the
 * job's exit wakes it. Treating it as done parked tekdok 024 mid-E2E, twice.
 */
export const BACKGROUND = /\b\d+ (?:shells?|monitors?)\b/;
/**
 * Both mean "ready for input" — herdr says `done` until a client has seen the
 * pane, and the runner never focuses it. Checking `idle` alone parked tekdok
 * 027 mid-E2E on Karel, a run after the BACKGROUND fix. (boilerplate#48)
 */
const READY = new Set(["idle", "done"]);
const busy = async (name) =>
  BACKGROUND.test(
    (await readPane(name)).trim().split("\n").slice(-4).join("\n"),
  );

/** Clamped: a deadline that passed mid-poll gave herdr a negative timeout (kanban 206). */
const waitFor = (name, until, ms) => {
  const t = Math.max(1000, Math.round(ms));
  return hx(["agent", "wait", name, ...until, "--timeout", String(t)], t + 15000);
};

/**
 * `agent_prompt_stalled` means the keystrokes never landed — the pane is still
 * at an empty prompt — so one resend is safe and usually enough.
 */
async function promptAgent(name, prompt, taskMs) {
  const args = [
    "agent",
    "prompt",
    name,
    prompt,
    "--wait",
    "--timeout",
    String(taskMs),
  ];
  try {
    return await hx(args, taskMs + 15000);
  } catch (err) {
    if (!/agent_prompt_stalled/.test(err.message)) throw err;
    await sleep(3000);
    return hx(args, taskMs + 15000);
  }
}

/**
 * Start `claude args...` in a fresh tab, send `prompt`, and wait it out.
 * A blocked agent — the startup trust dialog, or a permission prompt mid-run —
 * fires onBlocked and then waits for a human to answer it from the phone,
 * within blockedMs of total wall clock.
 */
export async function runInHerdr(opts) {
  const { name, cwd, args, prompt, taskMs, blockedMs, onBlocked, done } = opts;
  const pollMs = opts.pollMs ?? 30000;
  const end = Date.now() + taskMs;
  // False until a wait actually hands us an agent. `agent start` resolving is
  // not proof: it answered `agent_not_ready` for a pane that never registered
  // one at all, and the next call said `agent_not_found` (task-032).
  let started = false;
  await reap();
  const ws = await ensureWorkspace(cwd);
  const args0 = ["tab", "create", "--workspace", ws, "--cwd", cwd];
  const t = await hx([...args0, "--label", name, "--no-focus"]);

  /**
   * Notify the phone and wait for each block to be answered, until settled.
   * The budget starts at the first block, not at task start.
   */
  const clear = async (agent) => {
    const deadline = Date.now() + blockedMs;
    while (agent.agent_status === "blocked" && Date.now() < deadline) {
      await onBlocked?.(await readPane(name));
      await waitFor(name, LEAVING, deadline - Date.now());
      ({ agent } = await waitFor(name, SETTLED, deadline - Date.now()));
      await sleep(2000); // the TUI redraws after a dialog; prompting too soon stalls
    }
    return agent;
  };

  try {
    await hx(
      [
        "agent",
        "start",
        name,
        "--kind",
        "claude",
        "--pane",
        t.root_pane.pane_id,
        "--timeout",
        "60000",
        "--",
        ...args,
      ],
      90000,
    ).catch((err) => {
      // Blocked during startup: the name stays usable, so answer it like any block.
      if (!/agent_not_ready/.test(err.message)) throw err;
    });

    const first = await waitFor(name, SETTLED, 60000);
    started = true;
    await clear(first.agent);
    // A still-blocked agent makes promptAgent fail with agent_blocked, below.
    let agent = await clear((await promptAgent(name, prompt, taskMs)).agent);
    // Idle on a background job and not done yet: wait for the job to wake it.
    while (
      READY.has(agent.agent_status) &&
      Date.now() < end &&
      !done?.() &&
      (await busy(name))
    ) {
      // Poll, not `--until working`: a quick wake-up can finish in between.
      await sleep(pollMs);
      agent = await clear(
        (await waitFor(name, SETTLED, end - Date.now())).agent,
      );
    }
    const stuck = agent.agent_status === "blocked";
    return { code: stuck ? 1 : 0, output: await readPane(name), started };
  } catch (err) {
    // A herdr timeout or CLI error is a stuck run, not a crash: keep the log.
    return { code: 1, output: await readPane(name), err: err.message, started };
  }
  // Deliberately no `finally` close: the pane stays open at the shell prompt so
  // a human can type a follow-up and close it themselves. The next run's reap()
  // reclaims it; an idle runner leaves it until the human does. (task-008)
}
