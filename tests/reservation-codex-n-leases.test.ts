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

// On 21/11/2026 the coordinator (Claude 5 ibqho, 20261121T220653Z-claude-5-ibqho-c51b, option (a)) released Codex N's
// #2674 extension row for #3067: #2674 already conflicts with main in lib/inbound-mail.ts and will be re-merged on top of
// #3067's block by its adopter (Claude 5 iacVn3r, 20261121T220553Z-claude-5-f44e and 20261121T225749Z-claude-5-cdd3),
// who re-reserves what it still needs after #3067 enters. #2674's "unknown -> retry" is not superseded by main: main's
// withinLimit is fail-open when Redis cannot be asked. A releaser only removes whole rows (onlyRemoves), so the row goes.
test("Codex N's #2674 extension row is released, and lib/inbound-mail.ts is no longer reserved", () => {
  assert.deepEqual(held("SG2(17) #2674 extension"), []);
  assert.equal(rows.some((r) => r.file === "lib/inbound-mail.ts"), false, "lib/inbound-mail.ts is still reserved in codex.md");
});

test("Codex H2's SES row, whose port went to #3067 on 09/11 (C1-20261109-1603-TODOS-71), is released", () => {
  assert.deepEqual(held("SES/CX123(24): require exact deduplication claim evidence"), []);
  // Codex H2's other SES rows (codex/h-sns-recipient-shape) are another unit and stay.
  assert.ok(held("SES/CX123(24): recipient list must be exact").includes("lib/sns.ts"));
  assert.equal(rows.some((r) => r.file === "tests/ses-dedup-ack-world.ts"), false, "tests/ses-dedup-ack-world.ts is still reserved in codex.md");
});

test("Codex A3's row for the closed #2338 (codex/a3-c97a-email) is released", () => {
  assert.deepEqual(held("CX-101(1) / CX-102(a)"), []);
  assert.equal(text.includes("codex/a3-c97a-email"), false);
});

// On 21/11/2026 the coordinator (Claude 1, C1-20261121-2129-TODOS-2, item 3, comment 7071581632) released two more
// stale Codex rows that kept reservation-check failing on #4473 and #3813: Codex W's rows for #2508 (merged 14/11)
// and Codex A3's rows for #2352 (open, adopted by Claude 2 gallant, who re-reserves lib/email.ts in a claude2/ row if
// #2352 needs it again). A releaser only removes whole rows (onlyRemoves).
test("Codex A3's #2352 rows (codex/a3-c97b-mail-readiness) are released, and lib/email.ts is no longer reserved", () => {
  assert.deepEqual(held("CX-101(3) / CX-102(c)"), []);
  assert.equal(text.includes("codex/a3-c97b-mail-readiness"), false);
  assert.equal(rows.some((r) => r.file === "lib/email.ts"), false, "lib/email.ts is still reserved in codex.md");
});

test("Codex W's rows for the merged #2508 (codex/w-reminder-queue-evidence) are released, and lib/call-reminders.ts is free", () => {
  assert.equal(text.includes("codex/w-reminder-queue-evidence"), false);
  assert.equal(rows.some((r) => r.file === "lib/call-reminders.ts"), false, "lib/call-reminders.ts is still reserved in codex.md");
  // Codex W's other unit (codex/w-meeting-record-evidence) is not part of this release and stays.
  assert.ok(held("427 [VR1], CX-123(24): exact meeting record replies").includes("lib/meet-records.ts"));
});

test("no row records lib/inbox.ts as a hunk lease, since main released it on 09/11", () => {
  assert.doesNotMatch(text, /lib\/inbox\.ts: ONLY/);
  assert.doesNotMatch(text, /Additional lib\/inbox\.ts lease/);
});
