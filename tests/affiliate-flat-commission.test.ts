/**
 * 608 [WP7], unit 1: a flat amount per sale as an affiliate commission, as
 * pure rules (no Redis, no PayPal). The same 90% cap as a percentage, counted
 * with every partner share and second tier riding on the same sale; a full
 * refund cancels it; the amount is written in the store's currency.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  flatAfterRefund,
  flatAmountText,
  flatCommissionOn,
  flatProblem,
  MAX_FLAT_CENTS,
  MIN_FLAT_CENTS,
  readFlatCents,
} from "@/lib/affiliate-flat-commission";
import { MAX_BONUS_CENTS, MIN_BONUS_CENTS, commissionOn } from "@/lib/affiliate-setting";
import { MAX_COMMITTED_SHARE } from "@/lib/partner-share";
import { formatMoney } from "@/lib/money";

test("the amount a creator can set is a whole number of the currency's smallest unit, 1 to 10,000 in it", () => {
  assert.equal(MIN_FLAT_CENTS, MIN_BONUS_CENTS);
  assert.equal(MAX_FLAT_CENTS, MAX_BONUS_CENTS);
  assert.equal(readFlatCents(MIN_FLAT_CENTS), MIN_FLAT_CENTS);
  assert.equal(readFlatCents(MAX_FLAT_CENTS), MAX_FLAT_CENTS);
  assert.equal(readFlatCents(2500), 2500);
  for (const bad of [MIN_FLAT_CENTS - 1, MAX_FLAT_CENTS + 1, 0, -100, 25.5, Number.NaN, Infinity, "2500", null, undefined, {}]) {
    assert.equal(readFlatCents(bad), null, String(bad));
  }
});

test("a sale earns exactly the flat amount when the cap leaves room for it", () => {
  assert.equal(flatCommissionOn(10_000, 2_500, 0), 2_500);
  assert.equal(flatCommissionOn(10_000, 2_500, 20), 2_500);
});

test("never above 90% of what was paid, counted with the partners and the second tier on the same sale", () => {
  assert.equal(MAX_COMMITTED_SHARE, 90);
  // $20 paid, $25 promised: 90% of $20.
  assert.equal(flatCommissionOn(2_000, 2_500, 0), 1_800);
  // Partners already take 20% of it: 70% is left.
  assert.equal(flatCommissionOn(10_000, 9_000, 20), 7_000);
  // Nothing left under the cap: nothing earned.
  assert.equal(flatCommissionOn(10_000, 2_500, 90), 0);
  assert.equal(flatCommissionOn(10_000, 2_500, 95), 0);
  for (const base of [1, 99, 100, 1_001, 2_777, 50_000]) {
    for (const others of [0, 5, 33, 60, 89]) {
      for (const flat of [MIN_FLAT_CENTS, 999, 2_500, MAX_FLAT_CENTS]) {
        const earned = flatCommissionOn(base, flat, others);
        assert.ok(earned !== null);
        assert.ok(earned <= flat, "never above the flat amount");
        assert.ok(earned <= commissionOn(base, MAX_COMMITTED_SHARE - others), "never above the cap");
        assert.ok(earned >= 0);
      }
    }
  }
});

test("nothing paid earns nothing", () => {
  assert.equal(flatCommissionOn(0, 2_500, 0), 0);
  assert.equal(flatCommissionOn(-500, 2_500, 0), 0);
});

test("an amount or a share that cannot be read is unknown, never zero and never the full amount", () => {
  assert.equal(flatCommissionOn(10_000, 50, 0), null);
  assert.equal(flatCommissionOn(10_000, Number.NaN, 0), null);
  assert.equal(flatCommissionOn(10_000.5, 2_500, 0), null);
  assert.equal(flatCommissionOn(Number.NaN, 2_500, 0), null);
  assert.equal(flatCommissionOn(10_000, 2_500, Number.NaN), null);
  assert.equal(flatCommissionOn(10_000, 2_500, -1), null);
  assert.equal(flatCommissionOn(10_000, 2_500, Infinity), null);
});

test("each payment of a membership earns the flat amount again, under that payment's own cap", () => {
  const payments = [3_000, 3_000, 1_000];
  assert.deepEqual(payments.map((paid) => flatCommissionOn(paid, 1_000, 0)), [1_000, 1_000, 900]);
});

test("a full refund cancels the commission; a partial one keeps it under the cap of what is kept", () => {
  assert.equal(flatAfterRefund(2_500, 10_000, 10_000, 0), 0);
  assert.equal(flatAfterRefund(2_500, 10_000, 12_000, 0), 0);
  // $80 back of $100: $20 kept, 90% of it is $18.
  assert.equal(flatAfterRefund(2_500, 10_000, 8_000, 0), 1_800);
  // $10 back: $90 kept, the $25 still fits.
  assert.equal(flatAfterRefund(2_500, 10_000, 1_000, 0), 2_500);
  // Nothing refunded: unchanged.
  assert.equal(flatAfterRefund(2_500, 10_000, 0, 0), 2_500);
  // A refund never raises what was earned, even when the cap was what cut it.
  assert.equal(flatAfterRefund(1_800, 2_000, 0, 0), 1_800);
  assert.equal(flatAfterRefund(1_000, 10_000, 1_000, 0), 1_000);
});

test("a refund that cannot be read is unknown", () => {
  assert.equal(flatAfterRefund(2_500, 10_000, Number.NaN, 0), null);
  assert.equal(flatAfterRefund(2_500, 10_000, -1, 0), null);
  assert.equal(flatAfterRefund(Number.NaN, 10_000, 1_000, 0), null);
  assert.equal(flatAfterRefund(-1, 10_000, 1_000, 0), null);
  assert.equal(flatAfterRefund(2_500, 10_000, 1_000, Number.NaN), null);
});

test("the amount is written in the store's own currency", () => {
  assert.equal(flatAmountText(2_500, "usd"), "$25");
  assert.equal(flatAmountText(2_550, "usd"), "$25.50");
  assert.equal(flatAmountText(2_500, "eur"), formatMoney(2_500, "eur"));
  assert.equal(flatAmountText(2_500, "jpy"), formatMoney(2_500, "jpy"));
  assert.equal(flatAmountText(2_500, "cad"), "CA$25");
});

test("the studio is told when the amount cannot be set, or when the cap would cut it on this product's price", () => {
  assert.equal(flatProblem(2_500, 10_000, 0), null);
  assert.equal(flatProblem(50, 10_000, 0), "amount");
  assert.equal(flatProblem(Number.NaN, 10_000, 0), "amount");
  assert.equal(flatProblem(2_500, 2_000, 0), "over-cap");
  assert.equal(flatProblem(2_500, 10_000, 80), "over-cap");
  assert.equal(flatProblem(2_500, 10_000, Number.NaN), "unknown");
  assert.equal(flatProblem(2_500, Number.NaN, 0), "unknown");
});

test("an amount past the safe whole-number range is unknown, never read as exact cents", () => {
  const u = Number.MAX_SAFE_INTEGER + 1;
  assert.deepEqual(
    [flatCommissionOn(u, 2_500, 0), flatAfterRefund(u, 10_000, 0, 0), flatAfterRefund(2_500, 10_000, u, 0), flatProblem(2_500, u, 0)],
    [null, null, null, "unknown"],
  );
  assert.equal(flatAfterRefund(2_500, u, 0, 0), null);
  assert.equal(flatCommissionOn(-u, 2_500, 0), null);
  // Controls: the largest safe amounts still read as numbers.
  const s = Number.MAX_SAFE_INTEGER;
  assert.equal(flatCommissionOn(s, 2_500, 0), 2_500);
  assert.equal(flatAfterRefund(2_500, s, 0, 0), 2_500);
  assert.equal(flatProblem(2_500, s, 0), null);
});
