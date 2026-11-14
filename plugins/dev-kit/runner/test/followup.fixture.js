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
import { KANBAN, fakeApi } from "./fakeApi.js";

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
 * An in-memory Kanban holding one board and its cards. The first `racers` card
 * lookups wait for each other, so that many runners all pass the pre-check before
 * any of them inserts — the race the card lock exists for.
 */
export function fakeKanban(racers = 1) {
  const cards = [];
  let seq = 0;
  let release;
  const gate = new Promise((r) => (release = r));
  let waiting = 0;
  const kanban = { ...KANBAN, lists: { backlog: "Backlog" }, cards, inserts: 0 };
  fakeApi({
    board: () => ({
      id: "b",
      user_id: "u",
      lists: [{ id: "l-backlog", name: "Backlog" }],
    }),
    createCard: (o) => {
      const card = { ...o, id: `c${++seq}` };
      kanban.inserts++;
      cards.push(card);
      return { id: card.id };
    },
    deleteCard: ({ id }) => {
      cards.splice(
        cards.findIndex((c) => c.id === id),
        1,
      );
      return { deleted: true };
    },
    updateCard: ({ id, set }) => {
      Object.assign(
        cards.find((c) => c.id === id),
        set,
      );
      return { updated: true };
    },
    cards: async ({ paths }) => {
      if (waiting < racers) {
        if (++waiting === racers) release();
        await gate;
      }
      return cards
        .filter((c) => paths.includes(c.task_file_path))
        .map(({ id }) => ({ id }));
    },
  });
  return kanban;
}
