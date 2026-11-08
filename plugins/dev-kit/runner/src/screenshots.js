/**
 * Proof of work on the card (svelte-hasura-boilerplate#69). `/verify` saves 1–3
 * screenshots of a UI task as `<task dir>/<stem>-*.png` — gitignored like the `.log`
 * (repo.js ignoreLogs) — and closeLoop hands them to the Kanban app, which stores them
 * where every other card upload goes and lists them on the card as attachments.
 */

import { copyFileSync, existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { gql } from "./kanban.js";

const MAX = 3;

/** This task's screenshots in `full`, oldest name first — at most three. */
export function screenshotsOf(full, stem) {
  if (!existsSync(full)) return [];
  return readdirSync(full)
    .filter((n) => n.startsWith(`${stem}-`) && /\.png$/i.test(n))
    .sort()
    .slice(0, MAX);
}

/**
 * A pull request run writes them in its worktree, which is removed once the branch
 * ships. Copy them to the main checkout, where closeLoop looks when the PR merges.
 */
export function carryScreenshots(from, to, stem) {
  for (const n of screenshotsOf(from, stem))
    copyFileSync(join(from, n), join(to, n));
}

const ATTACHED = `query U($id: uuid!) { uploads(where: {todo_id: {_eq: $id}}) { url } }`;

/** Upload the task's screenshots to card `id`; skips any already attached. */
export async function attachScreenshots(kanban, { full, stem, id }) {
  const names = screenshotsOf(full, stem);
  if (!names.length || !kanban.appUrl) return [];
  const { uploads } = await gql(kanban, ATTACHED, { id });
  const fresh = names.filter((n) => !uploads.some((u) => u.url.endsWith(n)));
  for (const name of fresh) {
    const form = new FormData();
    form.set("todo_id", id);
    form.set(
      "file",
      new Blob([readFileSync(join(full, name))], { type: "image/png" }),
      name,
    );
    const res = await fetch(new URL("/api/runner/upload", kanban.appUrl), {
      method: "POST",
      // SvelteKit refuses a form POST whose Origin is not its own.
      headers: {
        origin: new URL(kanban.appUrl).origin,
        "x-hasura-admin-secret": kanban.adminSecret,
      },
      body: form,
      signal: AbortSignal.timeout(60000),
    });
    const body = await res.json().catch(() => ({}));
    if (!body.success)
      throw new Error(`${name}: ${body.error ?? `HTTP ${res.status}`}`);
  }
  return fresh.length ? [`${fresh.length} screenshot(s) attached`] : [];
}
