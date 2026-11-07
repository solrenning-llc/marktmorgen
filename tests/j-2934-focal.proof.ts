import assert from "node:assert/strict";
import { test } from "node:test";
import { checkProp65, priorLowestPrice, recordPrice, type PriceStep } from "@/lib/physical-legal";

const DAY = 86400, T = 1794009600;
const old = { at: T - 40 * DAY, cents: 1000 };
test("healthy sequential history stays complete", () => {
  const h = recordPrice(recordPrice([old], 20, T - 2), 10, T);
  assert.deepEqual(priorLowestPrice(h, T), { cents: 20, complete: true });
});
test("same-second changes retain the applied minimum", () => {
  const h = recordPrice(recordPrice(recordPrice([old], 500, T), 20, T), 10, T + 1);
  assert.deepEqual(priorLowestPrice(h, T + 1), { cents: 20, complete: true });
});
test("new explicit unknown contract refuses a malformed dense history", () => {
  const h = [old, { at: T - 2, cents: "20" }] as unknown as PriceStep[];
  assert.equal(priorLowestPrice(h, T), "unreadable");
});
test("site suffix refused and exact site retained", () => {
  assert.equal(checkProp65("WARNING: Cancer - www.P65Warnings.ca.gov"), null);
  assert.equal(checkProp65("WARNING: Cancer - www.P65Warnings.ca.gov.example.invalid"), "site");
});
// These are conditional in-memory typed boundaries. No storage reader is claimed.
test("a missing history slot cannot certify a filtered subset complete", () => {
  const h: PriceStep[] = [old];
  h.length = 2;
  const got = priorLowestPrice(h, T);
  console.log("SPARSE_HISTORY", JSON.stringify({ length: h.length, missing: !(1 in h), got }));
  assert.equal(got, "unreadable");
});
test("recording must not turn a missing slot into known history", () => {
  const h: PriceStep[] = [old];
  h.length = 2;
  const got = priorLowestPrice(recordPrice(h, 900, T - 1), T);
  console.log("SPARSE_AFTER_RECORD", JSON.stringify(got));
  assert.equal(got, "unreadable");
});
test("an entirely missing slot is unknown rather than empty history", () => {
  const h = new Array<PriceStep>(1);
  assert.equal(priorLowestPrice(h, T), "unreadable");
});
test("reading history does not mutate the original entries", () => {
  const h = [old, { at: T - 2, cents: 20 }];
  const saved = JSON.stringify(h);
  priorLowestPrice(h, T);
  assert.equal(JSON.stringify(h), saved);
});
