/**
 * Phone notes via ntfy.sh (free; Pushbullet moved push to its paid tier in 2026-10).
 * Set NTFY_TOPIC to a hard-to-guess topic name and subscribe to it in the ntfy app.
 * Silent no-op without a topic. NTFY_SERVER / NTFY_TOKEN are optional (self-hosted, ACL).
 */

const TOPIC = process.env.NTFY_TOPIC;
const SERVER = (process.env.NTFY_SERVER || "https://ntfy.sh").replace(/\/$/, "");
const TOKEN = process.env.NTFY_TOKEN;

/** HTTP headers are Latin-1; the JSON publish API takes the title as-is. */
export async function notify(title, body) {
  if (!TOPIC) return;
  try {
    const r = await fetch(SERVER, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(TOKEN && { Authorization: `Bearer ${TOKEN}` }),
      },
      body: JSON.stringify({ topic: TOPIC, title, message: body }),
      signal: AbortSignal.timeout(10000),
    });
    // Callers await this, so a failed push must show in the runner log.
    if (!r.ok) console.log(`notify failed: ${r.status} ${(await r.text()).slice(0, 200)}`);
  } catch (err) {
    console.log(`notify failed: ${err.message}`);
  }
}

/** Last n lines, capped so a note stays readable. */
export function tail(output, lines = 15) {
  return output.trimEnd().split("\n").slice(-lines).join("\n").slice(-1500);
}
