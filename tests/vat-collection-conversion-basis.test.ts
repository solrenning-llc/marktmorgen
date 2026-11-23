import assert from "node:assert/strict";
import { test } from "node:test";
import { PROVIDER_FEES } from "@/lib/receiving-costs";
import { vatCollectionCostOf, type VatFxAllowance } from "@/lib/eu-vat-collection-cost";
import { applyEuCollect, EuVatCollectRefused } from "@/lib/eu-vat-collect";

const now = new Date("2026-12-01T12:00:00Z");
const allowance: VatFxAllowance = { currency: "eur", bps: 300, source: "https://example.invalid/fx", checkedOn: "2026-11-20", validThrough: "2027-03-31" };
const ceiling = (cents: number, bps: number) => Number((BigInt(cents) * BigInt(bps) + BigInt(9999)) / BigInt(10000));
const other = (c: NonNullable<ReturnType<typeof vatCollectionCostOf>>) => c.fxCents + c.returnPaymentCents + c.refundReserveCents + c.disputeReserveCents;

for (const currency of ["eur", "gbp"] as const) for (const vat of [10000, 19000, 9000000000]) test(`the collected fee funds conversion of its full amount: ${currency} VAT ${vat}`, () => {
  const c = vatCollectionCostOf(vat, currency, [{ ...allowance, currency, bps: currency === "eur" ? 300 : 400 }], now);
  assert.ok(c);
  const collected = vat + c.feeCents;
  const conversionOnCollected = ceiling(collected, PROVIDER_FEES.stripe.conversionBps);
  assert.ok(collected - conversionOnCollected >= vat + other(c), `collected ${collected}, conversion ${conversionOnCollected}, VAT plus the other reserved parts ${vat + other(c)}`);
  assert.equal(c.conversionCents, conversionOnCollected);
});

test("the real checkout's fee still covers VAT and the other reserves after its own conversion", () => {
  const vat = 19000;
  const c = vatCollectionCostOf(vat, "eur", [allowance], now)!;
  const body = new URLSearchParams({ mode: "payment", "adaptive_pricing[enabled]": "false", "line_items[0][quantity]": "1", "line_items[0][price_data][currency]": "eur", "line_items[0][price_data][unit_amount]": "100000", "line_items[0][price_data][product_data][name]": "Synthetic" });
  applyEuCollect(body, { country: "DE", chooseYourPrice: false, buyerCurrencyLive: false, now, rates: [{ country: "DE", basisPoints: 1900, source: "https://example.invalid/de", readOn: "2026-11-20" }], costsCents: (v, currency) => vatCollectionCostOf(v, currency, [allowance], now)?.feeCents ?? null });
  const collected = Number(body.get("payment_intent_data[application_fee_amount]"));
  assert.equal(collected, vat + c.feeCents);
  assert.ok(collected - ceiling(collected, PROVIDER_FEES.stripe.conversionBps) >= vat + other(c));
  assert.ok(collected < vat + c.worstCaseCents, "the creator's processing cost remains outside the application fee");
});

test("whole-cent conversion is funded with the minimum fee, including one-cent VAT", () => {
  for (let vat = 1; vat <= 3000; vat++) {
    const c = vatCollectionCostOf(vat, "eur", [allowance], now)!;
    const collected = vat + c.feeCents;
    const needed = vat + other(c);
    assert.ok(collected - ceiling(collected, PROVIDER_FEES.stripe.conversionBps) >= needed);
    assert.ok(collected - 1 - ceiling(collected - 1, PROVIDER_FEES.stripe.conversionBps) < needed);
  }
});

test("the production default still refuses collection before changing the checkout body", () => {
  const body = new URLSearchParams({ mode: "payment", "adaptive_pricing[enabled]": "false", "line_items[0][quantity]": "1", "line_items[0][price_data][currency]": "eur", "line_items[0][price_data][unit_amount]": "100000", "line_items[0][price_data][product_data][name]": "Synthetic" });
  const before = body.toString();
  assert.throws(() => applyEuCollect(body, { country: "DE", chooseYourPrice: false, buyerCurrencyLive: false, now, rates: [{ country: "DE", basisPoints: 1900, source: "https://example.invalid/de", readOn: "2026-11-20" }] }), EuVatCollectRefused);
  assert.equal(body.toString(), before);
});
