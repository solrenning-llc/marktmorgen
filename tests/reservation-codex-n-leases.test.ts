import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { reservations } from "../scripts/reservation-check.mjs";

// #3206: Codex N's SG2(17) row records hunk-scoped leases. The file-level checker only
// reads the backticked files, so a file N still retains must stay in that list, and a
// file main released in full must not keep a stale lease in the same row.
const text = readFileSync("docs/reservations/codex.md", "utf8");
const row = text.split("\n").find((line) => line.includes("SG2(17): remaining paid-email callers fail closed"));

test("the SG2(17) row exists", () => {
  assert.ok(row, "Codex N's SG2(17) row is missing");
});

test("lib/store-join.ts stays reserved to Codex N while the row says N retains its other hunks", () => {
  assert.match(row ?? "", /N retains askToJoin\/readJoinToken/);
  const held = reservations(text, "codex").filter((r) => r.item.startsWith("SG2(17): remaining")).map((r) => r.file);
  assert.ok(held.includes("lib/store-join.ts"), `files reserved by the row: ${held.join(", ")}`);
});

test("a row that records lib/inbox.ts as released on 09/11 carries no lib/inbox.ts hunk lease", () => {
  assert.match(row ?? "", /inbox liberado em 09\/11/);
  assert.doesNotMatch(row ?? "", /lib\/inbox\.ts: ONLY/);
  assert.doesNotMatch(row ?? "", /Additional lib\/inbox\.ts lease/);
});
