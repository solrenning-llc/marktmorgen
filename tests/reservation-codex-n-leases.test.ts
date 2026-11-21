import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { reservations } from "../scripts/reservation-check.mjs";

// #3206 kept Codex N's SG2(17) row while N still held hunks of lib/store-join.ts. Codex only reads the
// repository since 12/11/2026, so Claude 2, its releaser (READ_ONLY_AGENTS), removed that stalled row
// (#4954, on the coordinator's request for #2287) and Codex A3's row for its closed #2338 (for #3817).
// These checks keep the released files free and the rows that a live unit still needs in place.
const text = readFileSync("docs/reservations/codex.md", "utf8");
const rows = reservations(text);
const held = (item: string) => rows.filter((r) => r.item.startsWith(item)).map((r) => r.file);

test("Codex N's SG2(17) remaining-callers row is released and no longer reserves lib/store-join.ts", () => {
  assert.equal(text.includes("SG2(17): remaining paid-email callers fail closed"), false);
  assert.equal(rows.some((r) => r.file === "lib/store-join.ts"), false, "lib/store-join.ts is still reserved in codex.md");
});

test("Codex N's #2674 extension row stays, with lib/inbound-mail.ts", () => {
  assert.ok(held("SG2(17) #2674 extension").includes("lib/inbound-mail.ts"));
});

test("Codex A3's row for the closed #2338 (codex/a3-c97a-email) is released", () => {
  assert.deepEqual(held("CX-101(1) / CX-102(a)"), []);
  assert.equal(text.includes("codex/a3-c97a-email"), false);
});

test("Codex A3's open #2352 row (codex/a3-c97b-mail-readiness) stays", () => {
  assert.ok(held("CX-101(3) / CX-102(c)").includes("lib/email.ts"));
});

test("no row records lib/inbox.ts as a hunk lease, since main released it on 09/11", () => {
  assert.doesNotMatch(text, /lib\/inbox\.ts: ONLY/);
  assert.doesNotMatch(text, /Additional lib\/inbox\.ts lease/);
});
