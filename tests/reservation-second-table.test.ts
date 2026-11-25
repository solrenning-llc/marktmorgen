/**
 * #5285 row #2604 (Claude 5's and Claude 1's LOW and Claude 7's LEVE on #2604, a Codex-family PR): lanePrefixes read a
 * second table that follows the Lanes table after only a blank line as more lanes, its header and its `| --- |`
 * separator included, so a branch could be taken for an agent's own by a row of another table. A blank line inside a
 * table must still not hide a row (tests/reservation-table-blanks.test.ts), so the boundary is the new table's own
 * separator row: the Lanes table ends there, as it does at prose or a `## ` heading.
 *
 * The reservations table is left as it is, on purpose: there a later table's header and separator name no file in
 * backticks, so they reserve nothing, and dropping a row before a separator-shaped line could hide a real reservation.
 * Its later rows stay enforced (the side that never lets a reservation go unseen); the last test holds that.
 * Synthetic text only.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { agentOfBranch, conflicts, lanePrefixes, reservations } from "../scripts/reservation-check.mjs";

const laneHeading = ["Lanes (who owns which subjects):", "", "| Agent | Branch prefix | Lane |", "| --- | --- | --- |"];
const codexLane = "| Codex (ChatGPT) | codex/ | Money |";
const reservationHeading = ["## Reservations before code", "", "| Agent | Item | Branch | Files (exact paths) | Since |", "| --- | --- | --- | --- | --- |"];
const first = "| Codex | first | codex/first | `lib/first.ts` | 05/11/2026 |";
const second = "| Codex | second | codex/second | `lib/second.ts` | 05/11/2026 |";

test("lanes end at a second table's separator, even after only a blank line", () => {
  const text = [...laneHeading, codexLane, "", "| Agent | `claude/` | Lane |", "| :--- | ---: | :---: |", "| Claude 3 | claude3/ | Agent |"].join("\n");
  const lanes = lanePrefixes(text);
  assert.deepEqual(lanes, [{ agent: "codex", prefix: "codex/" }]);
  assert.equal(agentOfBranch("claude3/probe", lanes), null);
  assert.equal(agentOfBranch("claude/probe", lanes), null);
});

test("control: a blank line inside the Lanes table is not a boundary", () => {
  assert.deepEqual(lanePrefixes([...laneHeading, codexLane, "", "| Claude 3 | claude3/ | Agent |"].join("\n")).map((l) => l.agent), ["codex", "claude 3"]);
});

test("reservations: a later table after a blank line reserves nothing by its header and separator, and its rows stay enforced", () => {
  const text = [...reservationHeading, first, "", "| Agent | Item | Branch | Files (exact paths) | Since |", "| --- | --- | --- | --- | --- |", second].join("\n");
  assert.deepEqual(reservations(text).map((r: { file: string }) => r.file), ["lib/first.ts", "lib/second.ts"]);
  const lanes = [...laneHeading, codexLane, "| Claude 3 | claude3/ | Agent |"].join("\n");
  const result = conflicts({ text: lanes, branch: "claude3/probe", changed: ["lib/second.ts"], agentFiles: [{ path: "docs/reservations/codex.md", text }] });
  assert.deepEqual(result.found.map((r: { file: string }) => r.file), ["lib/second.ts"]);
});
