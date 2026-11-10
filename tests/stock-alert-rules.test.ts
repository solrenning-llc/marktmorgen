/**
 * 623 [SZ7], unit 1: back-in-stock signups, the creator's low-stock alert
 * and a per-buyer limit on a limited product, as pure rules (no Redis, no
 * email). A count that cannot be read never sends, never alerts and never
 * lets a purchase past the limit.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  crossedLow,
  MAX_LOW_STOCK,
  MAX_PER_BUYER,
  MAX_STOCK_ALERTS,
  perBuyerAllows,
  readLowStock,
  readPerBuyer,
  restocked,
  stockAlertSignup,
} from "@/lib/stock-alert-rules";
import { MAX_STOCK } from "@/lib/product-extras";
import { MAX_WAITLIST } from "@/lib/waitlist-rules";

test("the 'Email me when it's back' box is offered only on a sold-out limited product, under the per-product ceiling", () => {
  assert.equal(MAX_STOCK_ALERTS, MAX_WAITLIST);
  assert.equal(stockAlertSignup(0, 0), "open");
  assert.equal(stockAlertSignup(0, MAX_STOCK_ALERTS - 1), "open");
  assert.equal(stockAlertSignup(0, MAX_STOCK_ALERTS), "full");
  // Units left: buy it instead.
  assert.equal(stockAlertSignup(3, 0), "in-stock");
  // Not limited at all (null left): nothing to wait for.
  assert.equal(stockAlertSignup(null, 0), "not-limited");
  for (const bad of [Number.NaN, -1, 1.5]) assert.equal(stockAlertSignup(bad, 0), "unknown", String(bad));
  for (const bad of [null, Number.NaN, -1, 2.5]) assert.equal(stockAlertSignup(0, bad), "unknown", String(bad));
});

test("a restock is only a sold-out product getting units back", () => {
  assert.equal(restocked(0, 5), "yes");
  assert.equal(restocked(0, 1), "yes");
  assert.equal(restocked(0, 0), "no");
  assert.equal(restocked(2, 10), "no");
  assert.equal(restocked(5, 0), "no");
  // No longer limited: whoever waited can buy it.
  assert.equal(restocked(0, null), "yes");
  assert.equal(restocked(null, 3), "no");
  for (const [before, after] of [[Number.NaN, 3], [0, Number.NaN], [-1, 3], [0, 1.5]] as const) {
    assert.equal(restocked(before, after), "unknown", `${before} → ${after}`);
  }
});

test("the low-stock number is off, or a whole number of units the product can hold", () => {
  assert.equal(MAX_LOW_STOCK, MAX_STOCK);
  assert.equal(readLowStock(""), 0);
  assert.equal(readLowStock(0), 0);
  assert.equal(readLowStock("0"), 0);
  assert.equal(readLowStock(5), 5);
  assert.equal(readLowStock(" 12 "), 12);
  assert.equal(readLowStock(MAX_LOW_STOCK), MAX_LOW_STOCK);
  for (const bad of [MAX_LOW_STOCK + 1, -1, 2.5, "five", Number.NaN, {}]) assert.equal(readLowStock(bad), null, String(bad));
});

test("the creator is told once each time the count crosses the low-stock number, never again until it rises above it", () => {
  assert.equal(crossedLow(6, 5, 5), "yes");
  assert.equal(crossedLow(10, 2, 5), "yes");
  assert.equal(crossedLow(5, 4, 5), "no", "already at or below: told when it first got there");
  assert.equal(crossedLow(4, 3, 5), "no");
  assert.equal(crossedLow(3, 8, 5), "no", "a restock is not a crossing down");
  assert.equal(crossedLow(8, 6, 5), "no");
  assert.equal(crossedLow(6, 5, 0), "no", "off");
  assert.equal(crossedLow(6, null, 5), "no", "no longer limited");
  assert.equal(crossedLow(null, 3, 5), "no", "just became limited: the page shows the number");
  // Rises above and falls again: told again.
  const counts = [10, 6, 5, 4, 9, 5, 0];
  const told = counts.slice(1).filter((after, i) => crossedLow(counts[i], after, 5) === "yes").length;
  assert.equal(told, 2);
  for (const [before, after, low] of [[Number.NaN, 5, 5], [6, 5, Number.NaN], [6, -1, 5], [6, 5, -1]] as const) {
    assert.equal(crossedLow(before as number, after as number, low as number), "unknown", `${before} → ${after} (${low})`);
  }
});

test("the per-buyer limit is off, or 1 to 100 units", () => {
  assert.equal(MAX_PER_BUYER, 100);
  assert.equal(readPerBuyer(""), 0);
  assert.equal(readPerBuyer(0), 0);
  assert.equal(readPerBuyer(1), 1);
  assert.equal(readPerBuyer("3"), 3);
  assert.equal(readPerBuyer(MAX_PER_BUYER), MAX_PER_BUYER);
  for (const bad of [MAX_PER_BUYER + 1, -2, 1.5, "x", Number.NaN]) assert.equal(readPerBuyer(bad), null, String(bad));
});

test("a second purchase above the limit by the same paying address is refused before the checkout", () => {
  assert.equal(perBuyerAllows(0, 50, 10), "ok", "off");
  assert.equal(perBuyerAllows(2, 0, 1), "ok");
  assert.equal(perBuyerAllows(2, 0, 2), "ok");
  assert.equal(perBuyerAllows(2, 1, 1), "ok");
  assert.equal(perBuyerAllows(2, 1, 2), "over");
  assert.equal(perBuyerAllows(2, 2, 1), "over");
  assert.equal(perBuyerAllows(1, 0, 3), "over");
});

test("what a buyer already bought, when it cannot be read, refuses rather than letting them past", () => {
  for (const bad of [null, undefined, Number.NaN, -1, 0.5]) assert.equal(perBuyerAllows(2, bad, 1), "unknown", String(bad));
  for (const bad of [0, -1, 1.5, Number.NaN]) assert.equal(perBuyerAllows(2, 0, bad), "unknown", `quantity ${bad}`);
  assert.equal(perBuyerAllows(Number.NaN, 0, 1), "unknown");
  assert.equal(perBuyerAllows(MAX_PER_BUYER + 1, 0, 1), "unknown");
});
