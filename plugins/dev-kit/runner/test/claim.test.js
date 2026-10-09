import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { claim } from "../src/claim.js";

const CARD = "aaaaaaaa-1111-2222-3333-444455556666";

/** A clone with one Auto task file, and the commit it sits at. */
function repo(body) {
  const path = mkdtempSync(join(tmpdir(), "claim-"));
  const git = (...a) => execFileSync("git", a, { cwd: path, encoding: "utf8" });
  git("init", "-q");
  mkdirSync(join(path, "doc/todo"), { recursive: true });
  const name = "007-cookie-TODO.md";
  writeFileSync(join(path, "doc/todo", name), body);
  git("add", "-A");
  git("-c", "user.email=t@t.t", "-c", "user.name=t", "commit", "-qm", "task");
  const task = { name, path: join(path, "doc/todo", name) };
  return { path, task, head: () => git("rev-parse", "HEAD").trim() };
}

/** An in-memory Hasura: one board, cards with an `agent_machine` swapped atomically. */
function fakeKanban(cards = []) {
  let seq = 0;
  const kanban = {
    endpoint: "x",
    adminSecret: "s",
    lists: { todo: "TODO" },
    cards,
  };
  globalThis.fetch = async (_url, { body }) => {
    const { query, variables: v } = JSON.parse(body);
    await new Promise((r) => setImmediate(r));
    let data;
    if (query.includes("update_todos(")) {
      const c = cards.find((c) => c.id === v.id);
      const free = !c.agent_machine || c.agent_machine === v.m;
      if (free) c.agent_machine = v.m;
      data = { update_todos: { affected_rows: free ? 1 : 0 } };
    } else if (query.includes("boards("))
      data = {
        boards: [
          { id: "b", user_id: "u", lists: [{ id: "l-todo", name: "TODO" }] },
        ],
      };
    else if (query.includes("insert_todos_one")) {
      const card = { ...v.o, id: `c${++seq}` };
      cards.push(card);
      data = { insert_todos_one: { id: card.id } };
    } else if (query.includes("delete_todos_by_pk")) {
      cards.splice(
        cards.findIndex((c) => c.id === v.id),
        1,
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

test("of two runners claiming the same card, exactly one wins — and git never moves", async () => {
  const { path, task, head } = repo(
    `# Cookie\n\n_From Kanban card \`${CARD}\`._\n`,
  );
  const kanban = fakeKanban([{ id: CARD, agent_machine: null }]);
  const before = head();
  const args = (me) => ({ repoName: "o/r", dir: "doc/todo", task, me });

  const won = await Promise.all([
    claim(kanban, args("dell")),
    claim(kanban, args("karel")),
  ]);

  assert.deepEqual(won.toSorted(), [false, true]);
  assert.equal(kanban.cards[0].agent_machine, won[0] ? "dell" : "karel");
  assert.equal(head(), before, "no claim commit");
  assert.equal(
    execFileSync("git", ["status", "--porcelain"], {
      cwd: path,
      encoding: "utf8",
    }),
    "",
  );
  // The winner claims again after a restart; the loser still loses.
  const winner = won[0] ? "dell" : "karel";
  assert.equal(await claim(kanban, args(winner)), true);
  assert.equal(
    await claim(kanban, args(winner === "dell" ? "karel" : "dell")),
    false,
  );
});

test("a card-less task is adopted as one TODO card, however many runners race for it", async () => {
  const { task } = repo("# Gate failure\n");
  const kanban = fakeKanban();
  const args = (me) => ({ repoName: "o/r", dir: "doc/todo", task, me });

  const won = await Promise.all([
    claim(kanban, args("dell")),
    claim(kanban, args("karel")),
  ]);

  assert.deepEqual(won.toSorted(), [false, true]);
  assert.equal(kanban.cards.length, 1);
  assert.equal(kanban.cards[0].task_file_path, "doc/todo/007-cookie-TODO.md");
  assert.equal(kanban.cards[0].list_id, "l-todo");
  assert.equal(kanban.cards[0].title, "Gate failure");
});

test("with no Kanban there is nothing to lock with, so the task is taken", async () => {
  const { task } = repo("# T\n");
  assert.equal(
    await claim({}, { repoName: "o/r", dir: "doc/todo", task, me: "dell" }),
    true,
  );
});
