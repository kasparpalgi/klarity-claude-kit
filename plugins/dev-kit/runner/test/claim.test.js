import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { claim, withMachine } from "../src/claim.js";

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

/**
 * An in-memory Hasura: one board, cards with an `agent_machine` swapped atomically.
 * `late` cards only show up from the `n`th look at a path on.
 */
function fakeKanban(cards = [], late = { n: Infinity, cards: [] }) {
  let looks = 0;
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
      const free = c && (!c.agent_machine || c.agent_machine === v.m);
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
    } else if (query.startsWith("query K")) {
      const c = cards.find((c) => c.id === v.id);
      data = { todos_by_pk: c ? { id: c.id } : null };
    } else if (query.includes("delete_todos_by_pk")) {
      cards.splice(
        cards.findIndex((c) => c.id === v.id),
        1,
      );
      data = {};
    } else {
      if (++looks === late.n) cards.unshift(...late.cards);
      data = {
        todos: cards
          .filter((c) => c.task_file_path === v.path)
          .map(({ id }) => ({ id })),
      };
    }
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

test("a card deleted since its file was written is not another runner's claim", async () => {
  const { task } = repo(`# Cookie\n\n_From Kanban card \`${CARD}\`._\n`);
  const kanban = fakeKanban();
  const won = await claim(kanban, {
    repoName: "o/r",
    dir: "doc/todo",
    task,
    me: "dell",
  });
  assert.equal(won, true);
  assert.equal(kanban.cards.length, 1, "adopted as a new card");
  assert.equal(kanban.cards[0].agent_machine, "dell");
});

test("an older card that shows up after ours was claimed wins, and ours is dropped", async () => {
  const { task } = repo("# Gate failure\n");
  const kanban = fakeKanban([], {
    n: 3,
    cards: [
      {
        id: "older",
        task_file_path: "doc/todo/007-cookie-TODO.md",
        agent_machine: "karel",
      },
    ],
  });
  const won = await claim(kanban, {
    repoName: "o/r",
    dir: "doc/todo",
    task,
    me: "dell",
  });
  assert.equal(won, false);
  assert.deepEqual(
    kanban.cards.map((c) => c.id),
    ["older"],
  );
});

test("withMachine puts the line under the tier line", () => {
  assert.equal(
    withMachine("> Run with: Opus 5 / high\n\n# T\n", "dell"),
    "> Run with: Opus 5 / high\n> Machine: dell\n\n# T\n",
  );
  assert.equal(withMachine("\n# T\n", "dell"), "> Machine: dell\n\n# T\n");
});

test("with no Kanban the pushed `> Machine:` line is the lock, as before", async () => {
  const root = mkdtempSync(join(tmpdir(), "claim-"));
  const run = (cwd, ...a) => execFileSync("git", a, { cwd, encoding: "utf8" });
  run(root, "init", "-q", "--bare", "-b", "main", "origin.git");
  const name = "007-cookie-TODO.md";
  const clone = (who) => {
    run(root, "clone", "-q", "origin.git", who);
    const path = join(root, who);
    run(path, "config", "user.email", "t@t.t");
    run(path, "config", "user.name", who);
    return path;
  };
  const seed = clone("seed");
  mkdirSync(join(seed, "doc/todo"), { recursive: true });
  writeFileSync(
    join(seed, "doc/todo", name),
    "> Run with: Opus 5 / high\n\n# Cookie\n",
  );
  run(seed, "add", "-A");
  run(seed, "commit", "-qm", "task");
  run(seed, "push", "-q", "origin", "HEAD:main");
  const [dell, karel] = [clone("dell"), clone("karel")];
  const args = (path, me) => ({
    repoPath: path,
    repoName: "o/r",
    dir: "doc/todo",
    task: { name, number: "007", path: join(path, "doc/todo", name) },
    me,
  });

  assert.equal(await claim({}, args(dell, "dell")), true);
  assert.equal(await claim({}, args(karel, "karel")), false);
  assert.equal(run(karel, "status", "--porcelain"), "");
  run(karel, "pull", "-q", "--ff-only");
  assert.match(
    readFileSync(join(karel, "doc/todo", name), "utf8"),
    /^> Machine: dell$/m,
  );
});
