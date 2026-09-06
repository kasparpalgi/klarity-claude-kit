/** Pushbullet notes to the phone. Silent no-op without a token. */

const TOKEN = process.env.PUSHBULLET_ACCESS_TOKEN;

export async function notify(title, body) {
  if (!TOKEN) return;
  fetch("https://api.pushbullet.com/v2/pushes", {
    method: "POST",
    headers: { "Access-Token": TOKEN, "Content-Type": "application/json" },
    body: JSON.stringify({ type: "note", title, body }),
  }).catch(() => {});
}

/** Last n lines, capped so a Pushbullet note stays readable. */
export function tail(output, lines = 15) {
  return output.trimEnd().split("\n").slice(-lines).join("\n").slice(-1500);
}
