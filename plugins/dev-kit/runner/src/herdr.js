/**
 * Run Claude inside a herdr pane instead of as a bare child of the daemon, so
 * the agent is visible — and answerable — from the phone at herdr.servicehost.io.
 */

import { execFile } from "node:child_process";
import { promisify } from "node:util";

const exec = promisify(execFile);
const BIN = process.env.HERDR_BIN ?? "herdr";
const SETTLED = ["--until", "idle", "--until", "done", "--until", "blocked"];
const LEAVING = ["--until", "working", "--until", "idle", "--until", "done"];

async function raw(args, timeout = 20000) {
  const { stdout } = await exec(BIN, args, { timeout, maxBuffer: 8 << 20 });
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

/** Only one task runs at a time, so any surviving task-* agent is a crash leak. */
async function reap() {
  const { agents } = await hx(["agent", "list"]);
  for (const a of agents) {
    if (a.name?.startsWith("task-"))
      await hx(["tab", "close", a.tab_id]).catch(() => {});
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
      return await raw(["agent", "read", name, "--source", src, "--lines", "400"]);
    } catch (err) {
      last = err.message;
    }
  }
  return `herdr read failed: ${last}`;
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const waitFor = (name, until, ms) =>
  hx(["agent", "wait", name, ...until, "--timeout", String(ms)], ms + 15000);

/**
 * `agent_prompt_stalled` means the keystrokes never landed — the pane is still
 * at an empty prompt — so one resend is safe and usually enough.
 */
async function promptAgent(name, prompt, taskMs) {
  const args = ["agent", "prompt", name, prompt, "--wait", "--timeout", String(taskMs)];
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
  const { name, cwd, args, prompt, taskMs, blockedMs, onBlocked } = opts;
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
      ["agent", "start", name, "--kind", "claude", "--pane",
       t.root_pane.pane_id, "--timeout", "60000", "--", ...args],
      90000,
    ).catch((err) => {
      // Blocked during startup: the name stays usable, so answer it like any block.
      if (!/agent_not_ready/.test(err.message)) throw err;
    });

    await clear((await waitFor(name, SETTLED, 60000)).agent);
    // A still-blocked agent makes promptAgent fail with agent_blocked, below.
    const { agent } = await promptAgent(name, prompt, taskMs);
    const stuck = (await clear(agent)).agent_status === "blocked";
    return { code: stuck ? 1 : 0, output: await readPane(name) };
  } catch (err) {
    // A herdr timeout or CLI error is a stuck run, not a crash: keep the log.
    return { code: 1, output: await readPane(name), err: err.message };
  } finally {
    await hx(["tab", "close", t.tab.tab_id]).catch(() => {});
  }
}
