/** Pushbullet notes to the phone. Silent no-op without a token. */

const TOKEN = process.env.PUSHBULLET_ACCESS_TOKEN;

/** Callers await this, so a silent push is a bug we want in the runner log. */
export async function notify(title, body) {
  if (!TOKEN) return;
  try {
    const r = await fetch("https://api.pushbullet.com/v2/pushes", {
      method: "POST",
      headers: { "Access-Token": TOKEN, "Content-Type": "application/json" },
      body: JSON.stringify({ type: "note", title, body }),
      signal: AbortSignal.timeout(10000),
    });
    if (!r.ok) console.log(`notify failed: ${r.status} ${(await r.text()).slice(0, 200)}`);
  } catch (err) {
    console.log(`notify failed: ${err.message}`);
  }
}

/** Last n lines, capped so a Pushbullet note stays readable. */
export function tail(output, lines = 15) {
  return output.trimEnd().split("\n").slice(-lines).join("\n").slice(-1500);
}
