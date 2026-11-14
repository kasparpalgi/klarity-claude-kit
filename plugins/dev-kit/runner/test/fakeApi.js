/** The Kanban config every test hands the runner. */
export const KANBAN = { apiToken: "t".repeat(32), appUrl: "https://k.test" };

/**
 * Stand in for `POST <appUrl>/api/runner/<op>`: `ops[op](input)` answers `{ data }`,
 * a throw answers `{ error }`. `seen` lists every `[op, input]` in order; the fake
 * also checks the bearer token, as the real endpoint does.
 */
export function fakeApi(ops) {
  const seen = [];
  globalThis.fetch = async (url, { headers, body }) => {
    await new Promise((r) => setImmediate(r));
    const op = new URL(url).pathname.split("/").pop();
    const input = JSON.parse(body);
    seen.push([op, input]);
    const reply = (status, json) => ({
      ok: status < 400,
      status,
      json: async () => json,
    });
    if (headers.authorization !== `Bearer ${KANBAN.apiToken}`)
      return reply(401, { error: "Not authorized" });
    if (!ops[op]) return reply(404, { error: `Unknown op: ${op}` });
    try {
      return reply(200, { data: await ops[op](input) });
    } catch (err) {
      return reply(500, { error: err.message });
    }
  };
  return seen;
}
