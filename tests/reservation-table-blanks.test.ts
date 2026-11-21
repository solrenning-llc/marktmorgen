import assert from "node:assert/strict";
import test from "node:test";
import { agentOfBranch, conflicts, lanePrefixes, reservations } from "../scripts/reservation-check.mjs";

const laneHeading = ["Lanes (who owns which subjects):", "", "| Agent | Branch prefix | Lane |", "| --- | --- | --- |"];
const laneRows = ["| Codex (ChatGPT) | codex/ | Money |", "| Claude 2 | claude2/ | Product |", "| Claude 3 | claude3/ | Agent |"];
const reservationHeading = ["## Reservations before code", "", "| Agent | Item | Branch | Files (exact paths) | Since |", "| --- | --- | --- | --- | --- |"];
const first = "| Codex | first | codex/first | `lib/first.ts` | 05/11/2026 |";
const second = "| Codex | second | codex/second | `lib/second.ts` | 05/11/2026 |";
const denseLanes = [...laneHeading, ...laneRows].join("\n");
const ownFile = (text: string) => [{ path: "docs/reservations/codex.md", text }];

for (const [label, blank, newline] of [
  ["empty LF line", "", "\n"],
  ["whitespace LF line", " \t ", "\n"],
  ["empty CRLF line", "", "\r\n"],
  ["whitespace CRLF line", "\t", "\r\n"],
] as const) {
  test(`${label}: a later reservation remains enforced through the real conflict checker`, () => {
    const text = [...reservationHeading, first, blank, second].join(newline);
    assert.deepEqual(reservations(text).map((r: { file: string }) => r.file), ["lib/first.ts", "lib/second.ts"]);
    const result = conflicts({ text: denseLanes, branch: "claude3/probe", changed: ["lib/second.ts"], agentFiles: ownFile(text) });
    assert.equal(result.me, "claude 3");
    assert.deepEqual(result.found.map((r: { file: string }) => r.file), ["lib/second.ts"]);
  });
  test(`${label}: a later agent lane remains recognized and protected`, () => {
    const text = [...laneHeading, laneRows[0], blank, ...laneRows.slice(1)].join(newline);
    assert.equal(agentOfBranch("claude3/probe", lanePrefixes(text)), "claude 3");
    const result = conflicts({ text, branch: "claude3/probe", changed: ["lib/first.ts"], agentFiles: ownFile([...reservationHeading, first].join("\n")) });
    assert.deepEqual(result.found.map((r: { file: string }) => r.file), ["lib/first.ts"]);
  });
}

for (const boundary of ["## A different section", "This is prose outside the table."]) {
  test(`reservations stop at ${boundary} even after internal blank lines`, () => {
    const text = [...reservationHeading, first, "", boundary, "", "| Agent | Item | Branch | Files | Since |", "| --- | --- | --- | --- | --- |", second].join("\n");
    assert.deepEqual(reservations(text).map((r: { file: string }) => r.file), ["lib/first.ts"]);
  });
  test(`lanes stop at ${boundary} without consuming a later table`, () => {
    const text = [...laneHeading, laneRows[0], "", boundary, "", "| Agent | Prefix | Lane |", "| --- | --- | --- |", laneRows[2]].join("\n");
    const lanes = lanePrefixes(text);
    assert.equal(agentOfBranch("codex/probe", lanes), "codex");
    assert.equal(agentOfBranch("claude3/probe", lanes), null);
  });
}

test("dense tables preserve ownership, shared-path and unknown-branch behavior", () => {
  const text = [...reservationHeading, first, second].join("\n");
  assert.equal(conflicts({ text: denseLanes, branch: "codex/own", changed: ["lib/second.ts"], agentFiles: ownFile(text) }).found.length, 0);
  assert.equal(conflicts({ text: denseLanes, branch: "owner/unknown", changed: ["lib/second.ts"], agentFiles: ownFile(text) }).me, null);
  assert.equal(conflicts({ text: denseLanes, branch: "claude3/probe", changed: ["docs/codex-queue.md"], agentFiles: ownFile(text) }).found.length, 0);
});
