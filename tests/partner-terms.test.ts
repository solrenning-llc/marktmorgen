/**
 * 630 [HN6](39), unit 1: a partnership with an end date or "until revoked",
 * changed only with the partner's yes, with its history. Synthetic values only.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { parsePartnerShare, shareOn } from "@/lib/partner-share";
import {
  CHANGE_WAITS_SECONDS,
  MAX_TERM_DAYS,
  MAX_TERM_HISTORY,
  changeNeeds,
  changeOpen,
  lastDayWords,
  readHistory,
  readTermEnd,
  sameShare,
  shareRunning,
  stepOf,
  stepWords,
  termWords,
  withStep,
} from "@/lib/partner-terms-rules";

const A = "prodaaaaaa";
const B = "prodbbbbbb";
const DAY = 86400;
// 3 November 2026, 12:00 UTC.
const NOW = Date.UTC(2026, 10, 3, 12) / 1000;

test("an end is a real date after today, through that whole day; empty is until revoked", () => {
  assert.deepEqual(readTermEnd("", NOW), { ok: true, until: null });
  assert.deepEqual(readTermEnd(undefined, NOW), { ok: true, until: null });
  assert.deepEqual(readTermEnd("revoked", NOW), { ok: true, until: null });
  const end = readTermEnd("2027-03-04", NOW);
  assert.deepEqual(end, { ok: true, until: Date.UTC(2027, 2, 5) / 1000 });
  assert.equal(lastDayWords(Date.UTC(2027, 2, 5) / 1000), "March 4, 2027");
  // Today and the past are refused; so is a day that does not exist.
  assert.deepEqual(readTermEnd("2026-11-03", NOW), { ok: false });
  assert.deepEqual(readTermEnd("2026-01-01", NOW), { ok: false });
  assert.deepEqual(readTermEnd("2027-02-30", NOW), { ok: false });
  assert.deepEqual(readTermEnd("next year", NOW), { ok: false });
  assert.deepEqual(readTermEnd(1234, NOW), { ok: false });
  // Tomorrow is the earliest; ten years the latest.
  assert.equal(readTermEnd("2026-11-04", NOW).ok, true);
  const far = new Date((NOW + MAX_TERM_DAYS * DAY) * 1000).toISOString().slice(0, 10);
  const tooFar = new Date((NOW + (MAX_TERM_DAYS + 2) * DAY) * 1000).toISOString().slice(0, 10);
  assert.equal(readTermEnd(far, NOW).ok, true);
  assert.equal(readTermEnd(tooFar, NOW).ok, false);
});

test("a share with an end earns nothing on a sale paid at or after it", () => {
  const until = Date.UTC(2027, 2, 5) / 1000;
  const share = parsePartnerShare({ percent: 30, products: [A], until });
  assert.deepEqual(share, { percent: 30, products: [A], until });
  assert.equal(shareOn(share, A, until - 1), 30);
  assert.equal(shareOn(share, A, until), 0);
  assert.equal(shareOn(share, A, until + DAY), 0);
  // Asked without a time, it says what the share covers.
  assert.equal(shareOn(share, A), 30);
  // A share kept before ends existed reads as before.
  assert.deepEqual(parsePartnerShare({ percent: 30, products: [A] }), { percent: 30, products: [A] });
  assert.deepEqual(parsePartnerShare({ percent: 30, products: [A], until: "soon" }), { percent: 30, products: [A] });
  assert.equal(shareRunning(share, until - 1), true);
  assert.equal(shareRunning(share, until), false);
  assert.equal(shareRunning({ percent: 5, products: [A] }, NOW + 100 * 365 * DAY), true);
  assert.equal(shareRunning(null, NOW), false);
});

test("the earnings record reads the end at the sale's own time", async () => {
  const { readFileSync } = await import("node:fs");
  const source = readFileSync("lib/affiliates.ts", "utf8");
  assert.match(source, /shareOn\(a\.share, sale\.product, sale\.at\) > 0/);
  assert.match(source, /percent: shareOn\(partner\.share, sale\.product, sale\.at\)/);
});

test("the creator cannot change an agreed share alone, except ending one that runs until revoked", () => {
  const open = { percent: 30, products: [A, B] };
  const dated = { percent: 30, products: [A, B], until: NOW + 90 * DAY };
  assert.equal(changeNeeds(open, { percent: 30, products: [B, A] }, NOW), "same");
  // Lower, higher, other products, another end: all wait for the partner.
  assert.equal(changeNeeds(open, { percent: 20, products: [A, B] }, NOW), "ask");
  assert.equal(changeNeeds(open, { percent: 40, products: [A, B] }, NOW), "ask");
  assert.equal(changeNeeds(open, { percent: 30, products: [A] }, NOW), "ask");
  assert.equal(changeNeeds(open, { ...open, until: NOW + 30 * DAY }, NOW), "ask");
  assert.equal(changeNeeds(dated, { percent: 30, products: [A, B] }, NOW), "ask");
  // Ending: at once when it runs until revoked, asked when it has a date.
  assert.equal(changeNeeds(open, null, NOW), "now");
  assert.equal(changeNeeds(dated, null, NOW), "ask");
  // Over already: clearing it is tidying up; starting it again is a new agreement.
  assert.equal(changeNeeds(dated, null, dated.until), "now");
  assert.equal(changeNeeds(dated, { percent: 30, products: [A, B], until: NOW + 400 * DAY }, dated.until), "ask");
  assert.equal(sameShare(dated, { ...dated }), true);
  assert.equal(sameShare(dated, open), false);
});

test("a change waits 30 days for the answer, then lapses", () => {
  const change = { share: null, asked: NOW };
  assert.equal(changeOpen(change, NOW + CHANGE_WAITS_SECONDS - 1), true);
  assert.equal(changeOpen(change, NOW + CHANGE_WAITS_SECONDS), false);
  assert.equal(changeOpen(null, NOW), false);
});

test("the history keeps the newest steps, oldest first, and reads safely", () => {
  let history = readHistory(undefined);
  assert.deepEqual(history, []);
  for (let i = 0; i < MAX_TERM_HISTORY + 5; i++) history = withStep(history, stepOf("asked", "creator", { percent: 10, products: [A] }, NOW + i));
  assert.equal(history.length, MAX_TERM_HISTORY);
  assert.equal(history[0].at, NOW + 5);
  const kept = readHistory([
    { at: NOW + 2, by: "partner", kind: "declined", percent: null, products: 0, until: null },
    { at: NOW + 1, by: "creator", kind: "started", percent: 30, products: 2, until: null },
    { at: NOW, by: "someone", kind: "started" },
    { at: NOW, by: "creator", kind: "deleted" },
    "junk",
  ]);
  assert.deepEqual(kept.map((s) => s.kind), ["started", "declined"]);
});

test("every step reads as a plain US English sentence", () => {
  const until = Date.UTC(2027, 2, 5) / 1000;
  const at = NOW;
  assert.equal(stepWords(stepOf("started", "creator", { percent: 30, products: [A, B] }, at)), "November 3, 2026: started at 30% of 2 products, until ended.");
  assert.equal(stepWords(stepOf("asked", "creator", { percent: 20, products: [A], until }, at)), "November 3, 2026: the store asked to change it to 20% of 1 product, through March 4, 2027.");
  assert.equal(stepWords(stepOf("asked", "creator", null, at)), "November 3, 2026: the store asked to end it.");
  assert.equal(stepWords(stepOf("changed", "partner", { percent: 20, products: [A], until }, at)), "November 3, 2026: changed to 20% of 1 product, through March 4, 2027, agreed by both.");
  assert.equal(stepWords(stepOf("changed", "partner", null, at)), "November 3, 2026: ended, agreed by both.");
  assert.match(stepWords(stepOf("declined", "partner", null, at)), /said no to the change\. The terms before it still hold\.$/);
  assert.match(stepWords(stepOf("lapsed", "creator", null, at)), /not answered in 30 days/);
  assert.match(stepWords(stepOf("revoked", "creator", null, at)), /the store ended it\. What was already earned is still paid\.$/);
  assert.equal(termWords({ percent: 5, products: [A] }, NOW), "Until you or they end it");
  assert.equal(termWords({ percent: 5, products: [A], until }, NOW), "Through March 4, 2027");
  assert.equal(termWords({ percent: 5, products: [A], until }, until), "Ended after March 4, 2027");
});
