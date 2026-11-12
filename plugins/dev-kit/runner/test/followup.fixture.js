import { execFileSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/** A bare origin, two runner clones, a fake `gh` that counts the issues it opens. */
export function setup() {
  const root = mkdtempSync(join(tmpdir(), "followup-"));
  const run = (cwd, ...a) => execFileSync("git", a, { cwd, encoding: "utf8" });
  run(root, "init", "-q", "--bare", "origin.git");
  const seed = join(root, "seed");
  run(root, "clone", "-q", "origin.git", "seed");
  for (const [k, v] of [
    ["user.email", "t@t.t"],
    ["user.name", "t"],
  ])
    run(seed, "config", k, v);
  mkdirSync(join(seed, "doc/todo"), { recursive: true });
  writeFileSync(join(seed, "doc/todo/053-parent-DONE.md"), "# Parent\n");
  run(seed, "add", "-A");
  run(seed, "commit", "-qm", "base");
  run(seed, "push", "-q", "origin", "HEAD");
  const since = run(seed, "rev-parse", "HEAD").trim();
  writeFileSync(
    join(seed, "doc/todo/054-split.md"),
    "# Split out\n\n## Original Requirement\n\nDo it.\n",
  );
  run(seed, "add", "-A");
  run(seed, "commit", "-qm", "follow-up");
  run(seed, "push", "-q", "origin", "HEAD");

  const clone = (name) => {
    run(root, "clone", "-q", "origin.git", name);
    const path = join(root, name);
    for (const [k, v] of [
      ["user.email", "t@t.t"],
      ["user.name", name],
    ])
      run(path, "config", k, v);
    return path;
  };

  const bin = join(root, "bin");
  mkdirSync(bin);
  writeFileSync(
    join(bin, "gh"),
    `#!/bin/sh\necho x >> "${root}/issues"\necho '{"id":9001,"number":57,"html_url":"https://github.com/o/r/issues/57"}'\n`,
  );
  chmodSync(join(bin, "gh"), 0o755);
  process.env.PATH = `${bin}:${process.env.PATH}`;
  const issues = () =>
    existsSync(join(root, "issues"))
      ? readFileSync(join(root, "issues"), "utf8").split("\n").length - 1
      : 0;
  return { since, dell: clone("dell"), karel: clone("karel"), issues, run };
}

/**
 * An in-memory Hasura holding one board and its cards. The first `racers` card
 * lookups wait for each other, so that many runners all pass the pre-check before
 * any of them inserts — the race the card lock exists for.
 */
export function fakeKanban(racers = 1) {
  const cards = [];
  let seq = 0;
  let release;
  const gate = new Promise((r) => (release = r));
  let waiting = 0;
  const kanban = {
    endpoint: "x",
    adminSecret: "s",
    lists: { backlog: "Backlog" },
    cards,
    inserts: 0,
  };
  globalThis.fetch = async (_url, { body }) => {
    const { query, variables: v } = JSON.parse(body);
    await new Promise((r) => setImmediate(r));
    if (query.includes("todos(where") && waiting < racers) {
      if (++waiting === racers) release();
      await gate;
    }
    let data;
    if (query.includes("boards("))
      data = {
        boards: [
          {
            id: "b",
            user_id: "u",
            lists: [{ id: "l-backlog", name: "Backlog" }],
          },
        ],
      };
    else if (query.includes("insert_todos_one")) {
      const card = { ...v.o, id: `c${++seq}` };
      kanban.inserts++;
      cards.push(card);
      data = { insert_todos_one: { id: card.id } };
    } else if (query.includes("delete_todos_by_pk")) {
      cards.splice(
        cards.findIndex((c) => c.id === v.id),
        1,
      );
      data = {};
    } else if (query.includes("update_todos_by_pk")) {
      Object.assign(
        cards.find((c) => c.id === v.id),
        v.set,
      );
      data = {};
    } else
      data = {
        todos: cards
          .filter((c) => c.task_file_path === v.path)
          .map(({ id }) => ({ id })),
      };
    return { json: async () => ({ data }) };
  };
  return kanban;
}
