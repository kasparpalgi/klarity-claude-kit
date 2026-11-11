/**
 * The run's claude.ai/code link on the card (svelte-todo-kanban#221). With
 * `remoteControlAtStartup` on in the machine's Claude settings, every session is in
 * claude.ai/code and the app already — but only a `--remote-control` pane prints its
 * link, so the status line stayed bare. The transcript always records it: a
 * `bridge-session` line whose `cse_…` id is the `session_…` in the URL.
 */

import { readFileSync } from "node:fs";
import { findSessionFile } from "./sessionUsage.js";

/** A transcript's text → its session link, or null when it never joined claude.ai. */
export function bridgeUrl(text) {
  const m = /"bridgeSessionId":"cse_(\w+)"/.exec(text ?? "");
  return m ? `https://claude.ai/code/session_${m[1]}` : null;
}

/**
 * Look for the link in the transcript the run is writing until it shows, then hand it
 * to `onUrl` once. Returns `stop()`. A missing file is a quiet retry: the transcript
 * appears only after the first prompt. A session that never joined claude.ai (the
 * setting is off) stops the looking after `tries`, not hours of re-reading.
 */
export function watchLink({
  dir,
  sinceMs,
  onUrl,
  everyMs = 10000,
  tries = 30,
}) {
  const look = () => {
    if (--tries < 0) return stop();
    const file = findSessionFile(dir, sinceMs);
    let url = null;
    try {
      url = file && bridgeUrl(readFileSync(file, "utf8"));
    } catch {}
    if (!url) return;
    stop();
    onUrl(url);
  };
  const timer = setInterval(look, everyMs);
  const stop = () => clearInterval(timer);
  return stop;
}
