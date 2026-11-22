/** Synthetic ledger evidence: every reduction must be possible before the minimum can be payable. */
import assert from "node:assert/strict";
import { test } from "node:test";
import { affiliateBalance, type LedgerEntry } from "@/lib/own-affiliate-ledger";

const now = 1_800_000_000;
const earned: LedgerEntry = { kind: "earned", paymentId: "synthetic-payment", cents: 1_000, dueAt: now - 1 };
const low: LedgerEntry = { kind: "lowered", paymentId: "synthetic-payment", cents: 600 };
const impossible: LedgerEntry = { kind: "lowered", paymentId: "synthetic-payment", cents: 1_200 };
const orders = [[earned, low, impossible], [earned, impossible, low], [low, earned, impossible], [low, impossible, earned], [impossible, earned, low], [impossible, low, earned]];

for (const [i, entries] of orders.entries()) {
  test(`an impossible reduction stays unknown beside a valid one, order ${i + 1}`, () => {
    assert.equal(affiliateBalance(entries, now), "unknown");
  });
}

test("paying or reversing does not make contradictory evidence known", () => {
  for (const extra of [
    { kind: "paid", payoutId: "synthetic-payout", cents: 1_000 },
    { kind: "reversed", paymentId: "synthetic-payment" },
  ] satisfies LedgerEntry[]) {
    assert.equal(affiliateBalance([earned, low, impossible, extra], now), "unknown");
  }
});

test("valid reductions still take the minimum, once, in any order", () => {
  for (let cents = 0; cents <= 1_000; cents += 10) {
    const smaller: LedgerEntry = { ...low, cents };
    const expected = { payableCents: Math.min(cents, 600), heldCents: 0, debtCents: 0 };
    assert.deepEqual(affiliateBalance([earned, low, smaller, low], now), expected);
    assert.deepEqual(affiliateBalance([smaller, low, earned, smaller], now), expected);
  }
});

test("valid lowerings preserve held balances and debts", () => {
  assert.deepEqual(affiliateBalance([{ ...earned, dueAt: now + 1 }, low], now), { payableCents: 0, heldCents: 600, debtCents: 0 });
  assert.deepEqual(affiliateBalance([earned, low, { kind: "paid", payoutId: "synthetic-payout", cents: 1_000 }], now), { payableCents: 0, heldCents: 0, debtCents: 400 });
});

test("an unmatched reduction keeps the existing behavior until its earning is present", () => {
  assert.deepEqual(affiliateBalance([low, impossible], now), { payableCents: 0, heldCents: 0, debtCents: 0 });
  assert.equal(affiliateBalance([earned, impossible], now), "unknown");
});
