import { test } from "node:test";
import assert from "node:assert/strict";
import { KANBAN, fakeApi } from "./fakeApi.js";
import { unclaim } from "../src/claim.js";

const CARD = "aaaaaaaa-1111-2222-3333-444455556666";
const FROM = `_From Kanban card \`${CARD}\`._`;

/** One card whose `agent_machine` a release clears, compare-and-swap. */
function board(agent_machine) {
  const card = { id: CARD, agent_machine };
  const seen = fakeApi({
    releaseCard: ({ machine }) => {
      const held = card.agent_machine === machine;
      if (held) card.agent_machine = null;
      return { released: held };
    },
  });
  return { card, seen };
}

test("an Auto card claimed then sent to Backlog comes back Auto (#20)", async () => {
  const { card } = board("mac"); // claimCard set it as the run started
  const text = `> Run with: Sonnet 5 / medium\n\n# Cookie\n\n${FROM}\n`;
  assert.equal(await unclaim(KANBAN, text, "mac"), true);
  // Moved back to TODO, the Kanban writes `> Machine:` only from agent_machine.
  assert.equal(card.agent_machine, null);
});

test("a machine a person chose stays, and so does another runner's claim", async () => {
  const pinned = `> Run with: Sonnet 5 / medium\n> Machine: mac\n\n${FROM}\n`;
  const { card, seen } = board("mac");
  assert.equal(await unclaim(KANBAN, pinned, "mac"), false);
  assert.deepEqual(seen, [], "never asked the board");
  assert.equal(card.agent_machine, "mac");

  card.agent_machine = "karel";
  assert.equal(await unclaim(KANBAN, `# Cookie\n\n${FROM}\n`, "mac"), false);
  assert.equal(card.agent_machine, "karel");
});

test("no card, no board or a board that errors is never a release", async () => {
  fakeApi({});
  assert.equal(await unclaim(KANBAN, "# Cookie\n", "mac"), false);
  assert.equal(await unclaim({}, `# Cookie\n\n${FROM}\n`, "mac"), false);
  assert.equal(await unclaim(KANBAN, `# Cookie\n\n${FROM}\n`, "mac"), false);
});
