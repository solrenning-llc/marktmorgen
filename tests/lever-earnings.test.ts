import assert from "node:assert/strict";
import test from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { leverEarnedWords, leverEarnings, LEVER_CURRENCIES_MAX, type LeverEarned, type LeverKey } from "@/lib/lever-earnings";
import { measureSalesLevers, type LeverReading } from "@/lib/sales-levers";
import { SalesLevers } from "@/components/sales-levers";
import { claimHandle, storeForEmail } from "@/lib/store";
import { store as redis } from "./redis-stub";

// 752 [CD3] part (b): how much each sales lever earned in the last 30 days,
// summed only from the payment records the studio's kept sales reading already
// holds. Synthetic records only; no provider is called.

const now = Date.parse("2026-11-10T12:00:00Z");
const seconds = (ms: number) => Math.floor(ms / 1000);
type Opts = { cents?: number; currency?: string; created?: number | null; off?: number | null; extra?: Record<string, unknown> };
/** A paid Checkout Session as lib/stats.ts keeps it: `cents` from amount_total, `created` from created. */
function checkout(meta: Record<string, string>, o: Opts = {}) {
  const cents = o.cents ?? 4500;
  const currency = o.currency ?? "usd";
  const created = o.created === undefined ? seconds(now - 3_600_000) : o.created;
  const row: Record<string, unknown> = { object: "checkout.session", status: "complete", payment_status: "paid", amount_total: cents, currency, metadata: meta, ...o.extra };
  if (created !== null) row.created = created;
  if (o.off !== null) row.total_details = { amount_discount: o.off ?? 0, amount_tax: 0 };
  // lib/stats.ts falls back to "now" and to 0 when Stripe's answer lacks them; the aggregator must not trust that.
  return { created: created === null ? now : created * 1000, cents: typeof row.amount_total === "number" ? row.amount_total : 0, currency, upsell: false, row };
}
/** A one-click offer charge (PaymentIntent, metadata kind=upsell). */
function offer(o: { amount?: unknown; currency?: string; created?: number; afterNo?: unknown } = {}) {
  const created = o.created ?? seconds(now - 7_200_000);
  const currency = o.currency ?? "usd";
  const row: Record<string, unknown> = { object: "payment_intent", status: "succeeded", currency, created, metadata: { kind: "upsell", store: "s" } };
  if (o.amount !== undefined) row.amount = o.amount;
  if (o.afterNo !== undefined) (row.metadata as Record<string, unknown>).after_no = o.afterNo;
  return { created: created * 1000, cents: typeof o.amount === "number" ? o.amount : 0, currency, upsell: true, row };
}
const measured = (row: LeverReading["rows"][LeverKey] | undefined) => {
  assert.ok(row && "measured" in row && row.measured, "measured lever");
  return row;
};

test("an order bump earns its own price, not the whole order; a discounted or unpriced bump is left out and counted as left", () => {
  const reading = leverEarnings(
    [
      checkout({ bump: "extra001", bump_cents: "1500" }, { cents: 4500 }),
      checkout({ bump: "extra001", bump_cents: "1500", bump2: "extra002", bump2_cents: "700" }, { cents: 6700 }),
      checkout({ bump: "extra001", bump_cents: "1500" }, { cents: 4000, off: 500 }),
      checkout({ bump: "extra001" }, { cents: 4500 }),
      checkout({ bump: "extra001", bump_cents: "1500" }, { cents: 4500, off: null }),
      checkout({ bump: "extra001", bump_cents: "9000" }, { cents: 4500 }),
      checkout({}, { cents: 3000 }),
    ],
    "usd",
    false,
    now,
  );
  const bump = measured(reading.rows.bump);
  assert.deepEqual(bump.amounts, [{ currency: "usd", cents: 3700, orders: 2 }]);
  assert.equal(bump.left, 4);
  assert.equal(reading.complete, true);
});

test("upsell is each one-click offer charge as Stripe recorded it; a charge without an amount is left, never zero", () => {
  const reading = leverEarnings([offer({ amount: 900 }), offer({ amount: 1100 }), offer({})], "usd", false, now);
  const upsell = measured(reading.rows.upsell);
  assert.deepEqual(upsell.amounts, [{ currency: "usd", cents: 2000, orders: 2 }]);
  assert.equal(upsell.left, 1);
  // A one-click offer of a bundle is an upsell, not a bundle sale.
  assert.deepEqual(measured(reading.rows.bundle).amounts, [{ currency: "usd", cents: 0, orders: 0 }]);
});

test("a bundle earns the whole paid order whose product is a bundle; an order without an exact total is left", () => {
  const reading = leverEarnings(
    [checkout({ bundle: "inside001,inside002" }, { cents: 2400 }), checkout({ bundle: "inside001,inside002" }, { extra: { amount_total: null } })],
    "usd",
    false,
    now,
  );
  const bundle = measured(reading.rows.bundle);
  assert.deepEqual(bundle.amounts, [{ currency: "usd", cents: 2400, orders: 1 }]);
  assert.equal(bundle.left, 1);
});

test("a downsell is an offer whose payment says it followed a No thanks: counted apart from Upsell, and always as at least (752 [CD3] (b) unit 2)", () => {
  const reading = leverEarnings(
    [offer({ amount: 900, afterNo: "yes" }), offer({ amount: 400, afterNo: "yes" }), offer({ amount: 1500 }), offer({ amount: 700, afterNo: "no" }), offer({ amount: 300, afterNo: 1 }), offer({ afterNo: "yes" })],
    "usd",
    false,
    now,
  );
  const downsell = measured(reading.rows.downsell);
  assert.deepEqual(downsell.amounts, [{ currency: "usd", cents: 1300, orders: 2 }]);
  assert.equal(downsell.left, 1);
  // Only the exact mark: any other value is an upsell, as every offer was before the mark existed.
  assert.deepEqual(measured(reading.rows.upsell).amounts, [{ currency: "usd", cents: 2500, orders: 3 }]);
  // Older downsells carry no mark and stay under Upsell, so the downsell figure is a lower bound, said so.
  const clean = leverEarnings([offer({ amount: 900, afterNo: "yes" })], "usd", false, now);
  assert.equal(leverEarnedWords(clean.rows.downsell, "downsell", clean.complete).line, "Earned in the last 30 days: at least $9 from 1 order.");
  assert.match(leverEarnedWords(clean.rows.downsell, "downsell", true).how, /No thanks/);
  assert.match(leverEarnedWords(clean.rows.downsell, "downsell", true).how, /under Upsell/);
  assert.match(leverEarnedWords(clean.rows.upsell, "upsell", true).how, /Downsell/);
  assert.equal(leverEarnedWords(clean.rows.upsell, "upsell", true).line, "Earned in the last 30 days: $0 from 0 orders.");
});

test("checkout recovery and next offer are not recognizable in today's records: not measured, never zero", () => {
  const reading = leverEarnings(
    [checkout({ product: "p1" }, { extra: { recovered_from: "cs_test_old" } }), offer({ amount: 500 })],
    "usd",
    false,
    now,
  );
  for (const key of ["recovery", "next"] as const) {
    const row = reading.rows[key] as LeverEarned;
    assert.equal(row.measured, false, key);
    assert.equal("amounts" in row, false, key);
    const words = leverEarnedWords(row, key, reading.complete);
    assert.equal(words.line, "Not measured yet.");
    assert.doesNotMatch(words.line + words.how, /\$0|0 orders/);
  }
  // Stripe's recovered_from is its own recovery link, which Marktmorgen's reminder never sends (lib/checkout-recovery.ts).
  assert.match(leverEarnedWords(reading.rows.recovery, "recovery", true).how, /product page/);
});

test("each currency is summed on its own, the store's first, and never added to another", () => {
  const reading = leverEarnings(
    [offer({ amount: 900, currency: "eur" }), offer({ amount: 500 }), offer({ amount: 300, currency: "eur" }), offer({ amount: 100, currency: "gbp" })],
    "usd",
    false,
    now,
  );
  assert.deepEqual(measured(reading.rows.upsell).amounts, [
    { currency: "usd", cents: 500, orders: 1 },
    { currency: "eur", cents: 1200, orders: 2 },
    { currency: "gbp", cents: 100, orders: 1 },
  ]);
  const words = leverEarnedWords(reading.rows.upsell, "upsell", reading.complete);
  assert.equal(words.line, "Earned in the last 30 days: $5 from 1 order. Also €12 from 2 orders in EUR and £1 from 1 order in GBP, not added together.");
});

test("more currencies than the ceiling are counted as left, not dropped and not merged", () => {
  const codes = ["eur", "gbp", "cad", "aud", "jpy", "chf"];
  const reading = leverEarnings(codes.map((currency) => offer({ amount: 100, currency })), "usd", false, now);
  const upsell = measured(reading.rows.upsell);
  assert.equal(upsell.amounts.length, LEVER_CURRENCIES_MAX);
  assert.equal(upsell.amounts[0].currency, "usd");
  assert.equal(upsell.left, codes.length - (LEVER_CURRENCIES_MAX - 1));
});

test("only the last 30 days count; a record whose date or currency Stripe did not give makes the reading incomplete", () => {
  const old = seconds(now - 31 * 86_400_000);
  const inWindow = leverEarnings([offer({ amount: 500, created: old }), offer({ amount: 700 })], "usd", false, now);
  assert.deepEqual(measured(inWindow.rows.upsell).amounts, [{ currency: "usd", cents: 700, orders: 1 }]);
  assert.equal(inWindow.complete, true);
  // lib/stats.ts dates an undated record "now"; the row itself has no date, so where it falls is unknown.
  const undated = leverEarnings([checkout({ bundle: "inside001,inside002" }, { created: null })], "usd", false, now);
  assert.equal(undated.complete, false);
  assert.deepEqual(measured(undated.rows.bundle).amounts, [{ currency: "usd", cents: 0, orders: 0 }]);
  const noCurrency = leverEarnings([offer({ amount: 500, currency: "" })], "usd", false, now);
  assert.equal(noCurrency.complete, false);
  assert.deepEqual(measured(noCurrency.rows.upsell).amounts, [{ currency: "usd", cents: 0, orders: 0 }]);
});

test("the card says what is exact: zero only from a complete reading, 'at least' when incomplete or left", () => {
  const empty = leverEarnings([], "usd", false, now);
  assert.equal(leverEarnedWords(empty.rows.bump, "bump", empty.complete).line, "Earned in the last 30 days: $0 from 0 orders.");
  const partial = leverEarnings([offer({ amount: 500 })], "usd", true, now);
  assert.equal(leverEarnedWords(partial.rows.upsell, "upsell", partial.complete).line, "Earned in the last 30 days: at least $5 from 1 order.");
  assert.match(leverEarnedWords(partial.rows.upsell, "upsell", partial.complete).how, /incomplete/);
  const left = leverEarnings([offer({ amount: 500 }), offer({})], "usd", false, now);
  assert.equal(leverEarnedWords(left.rows.upsell, "upsell", left.complete).line, "Earned in the last 30 days: at least $5 from 1 order; 1 more order is not counted, because its exact amount is not in the payment record.");
  // No reading at all, or one kept before this count existed: not measured, never zero.
  assert.equal(leverEarnedWords(undefined, "bump", true).line, "Not measured yet.");
  assert.equal(leverEarnedWords({ records: 3, cents: 1200, scope: "Whole checkout payments" }, "bump", true).line, "Not measured yet.");
  // A store whose currency is not a code never gets a dollar figure by default.
  assert.equal(leverEarnedWords(leverEarnings([], "", false, now).rows.bump, "bump", true).line, "Not measured yet.");
});

test("a kept row whose figures do not read exactly is 'Not measured yet', never a figure (review of #3582, Codex C2, M1)", async () => {
  const usd = (cents: unknown, orders: unknown) => ({ currency: "usd", cents, orders });
  const eur = (cents: unknown, orders: unknown) => ({ currency: "eur", cents, orders });
  const row = (amounts: unknown, left: unknown = 0) => ({ measured: true, amounts, left }) as unknown as LeverEarned;
  const bad: [string, LeverEarned][] = [
    ["null cents", row([usd(null, 1)])],
    ["negative cents", row([usd(-900, 1)])],
    ["cents as a string", row([usd("900", 1)])],
    ["fractional cents", row([usd(9.5, 1)])],
    ["fractional orders", row([usd(900, 1.5)])],
    ["negative orders", row([usd(900, -1)])],
    ["negative left", row([usd(900, 1)], -1)],
    ["fractional left", row([usd(900, 1)], 0.5)],
    ["a null second amount", row([usd(900, 1), null])],
    ["a second amount with null cents", row([usd(900, 1), eur(null, 1)])],
    ["a second amount with a bad currency", row([usd(900, 1), { currency: "EURO", cents: 100, orders: 1 }])],
    ["amounts that are not a list", row({ 0: usd(900, 1) })],
  ];
  for (const [label, kept] of bad) {
    let line: string;
    try {
      line = leverEarnedWords(kept, "upsell", true).line;
    } catch (error) {
      line = `threw ${String(error)}`;
    }
    assert.equal(line, "Not measured yet.", label);
  }
  // Healthy controls: a valid zero, an exact figure, other currencies, and orders left.
  assert.equal(leverEarnedWords(row([usd(0, 0)]), "upsell", true).line, "Earned in the last 30 days: $0 from 0 orders.");
  assert.equal(leverEarnedWords(row([usd(900, 1)]), "upsell", true).line, "Earned in the last 30 days: $9 from 1 order.");
  assert.match(leverEarnedWords(row([usd(900, 1), eur(500, 2)]), "upsell", true).line, /Also .5 from 2 orders in EUR, not added together\./);
  assert.match(leverEarnedWords(row([usd(900, 1)], 2), "upsell", true).line, /at least \$9 from 1 order; 2 more orders are not counted/);
  // Through the real card: a malformed kept row renders as not measured and never throws.
  redis.clear();
  await claimHandle("earnedbad@example.test", "earnedbadfixture", "Synthetic earned", "");
  const store = (await storeForEmail("earnedbad@example.test"))!;
  const reading = leverEarnings([], "usd", false, now);
  const kept = { ...reading, rows: { ...reading.rows, upsell: row([usd(900, 1), null]), bump: row([usd(null, 1)]) } } as unknown as LeverReading;
  let html = "";
  try {
    html = renderToStaticMarkup(createElement(SalesLevers, { store, reading: kept, canConfigure: false }));
  } catch (error) {
    html = `threw ${String(error)}`;
  }
  assert.doesNotMatch(html, /\$0 from 1 order|threw/);
  assert.equal((html.match(/Not measured yet\./g) ?? []).length, 5);
});

test("measureSalesLevers is this count: the studio's kept reading carries it, with no provider call", () => {
  const original = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = (async () => {
    calls += 1;
    throw new Error("no provider call");
  }) as typeof fetch;
  try {
    const reading = measureSalesLevers([offer({ amount: 900 })], "usd", false, now);
    assert.deepEqual(measured(reading.rows.upsell).amounts, [{ currency: "usd", cents: 900, orders: 1 }]);
    assert.equal(reading.from, "2026-10-12T00:00:00.000Z");
    assert.equal(calls, 0);
  } finally {
    globalThis.fetch = original;
  }
});

test("each card shows what it earned or 'Not measured yet', and a kept reading from before still renders", async () => {
  redis.clear();
  await claimHandle("earned@example.test", "earnedfixture", "Synthetic earned", "");
  const store = (await storeForEmail("earned@example.test"))!;
  const reading = leverEarnings([offer({ amount: 900 }), checkout({ bump: "extra001", bump_cents: "1500" })], "usd", false, now);
  const html = renderToStaticMarkup(createElement(SalesLevers, { store, reading, canConfigure: false }));
  assert.match(html, /Earned in the last 30 days: \$15 from 1 order\./);
  assert.match(html, /Earned in the last 30 days: \$9 from 1 order\./);
  assert.equal((html.match(/Not measured yet\./g) ?? []).length, 3);
  assert.doesNotMatch(html, /tagged paid records/);
  const kept = { ...reading, rows: { ...reading.rows, upsell: { records: 1, cents: 900, scope: "old" } } } as unknown as LeverReading;
  assert.equal((renderToStaticMarkup(createElement(SalesLevers, { store, reading: kept, canConfigure: false })).match(/Not measured yet\./g) ?? []).length, 4);
  const none = renderToStaticMarkup(createElement(SalesLevers, { store, reading: null, canConfigure: false }));
  assert.equal((none.match(/Not measured yet\./g) ?? []).length, 6);
});
