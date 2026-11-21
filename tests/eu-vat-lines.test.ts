/**
 * EU VAT under art. 9a, part 2 of the build, unit 6a: the checkout's lines for a one-off sale whose VAT is collected
 * (docs/eu-vat-article-9a.md, "The code that would be needed", point 3, and "The margin consequence", points 1 and 2).
 *
 *   - the creator's own automatic tax is off for the sale, so the VAT is never charged twice;
 *   - the VAT is its own line, named with its country and rate, on top of the price;
 *   - the platform's fee becomes the share + the VAT + the VAT money's own costs, never taken from the share;
 *   - the VAT money's costs must be given: unknown is never zero, so without them nothing is written and the sale is
 *     refused; a membership (a fee in percent) is refused until its own design is built.
 * Pure, on a synthetic request body; nothing is sent.
 */
import { strict as assert } from "node:assert";
import { test } from "node:test";
import { applyEuVatLines } from "@/lib/eu-vat-lines";

const vat = { priceCents: 1000, vatCents: 190, totalCents: 1190, basisPoints: 1900, country: "DE" };
function body(): URLSearchParams {
  const b = new URLSearchParams();
  b.set("line_items[0][price_data][unit_amount]", "1000");
  b.set("line_items[0][price_data][currency]", "eur");
  b.set("line_items[0][quantity]", "1");
  b.set("automatic_tax[enabled]", "true");
  b.set("line_items[0][price_data][tax_behavior]", "exclusive");
  b.set("payment_intent_data[application_fee_amount]", "50");
  return b;
}

test("a one-off sale: the creator's automatic tax off, a VAT line on top, the fee raised by the VAT and its costs", () => {
  const b = body();
  assert.equal(applyEuVatLines(b, { vat, recurring: false, vatCostsCents: 12, currency: "eur" }), "ok");
  assert.equal(b.get("automatic_tax[enabled]"), null);
  assert.equal(b.get("line_items[0][price_data][tax_behavior]"), null);
  assert.equal(b.get("line_items[1][price_data][unit_amount]"), "190");
  assert.equal(b.get("line_items[1][price_data][currency]"), "eur");
  assert.equal(b.get("line_items[1][price_data][product_data][name]"), "VAT (Germany, 19%)");
  assert.equal(b.get("line_items[1][quantity]"), "1");
  assert.equal(b.get("payment_intent_data[application_fee_amount]"), String(50 + 190 + 12));
  assert.equal(b.get("payment_intent_data[metadata][eu_vat]"), "DE:1900:190");
});

test("with no share set, the fee is the VAT and its costs", () => {
  const b = body();
  b.delete("payment_intent_data[application_fee_amount]");
  assert.equal(applyEuVatLines(b, { vat, recurring: false, vatCostsCents: 12, currency: "eur" }), "ok");
  assert.equal(b.get("payment_intent_data[application_fee_amount]"), "202");
});

test("unknown costs, a membership, a broken amount or a fee that is not a whole number refuse the sale and write nothing", () => {
  const cases: [string, Parameters<typeof applyEuVatLines>[1], (b: URLSearchParams) => void][] = [
    ["costs unknown", { vat, recurring: false, vatCostsCents: null, currency: "eur" }, () => {}],
    ["costs negative", { vat, recurring: false, vatCostsCents: -1, currency: "eur" }, () => {}],
    ["membership", { vat, recurring: true, vatCostsCents: 12, currency: "eur" }, () => {}],
    ["vat broken", { vat: { ...vat, vatCents: Number.NaN }, recurring: false, vatCostsCents: 12, currency: "eur" }, () => {}],
    ["currency", { vat, recurring: false, vatCostsCents: 12, currency: "" }, () => {}],
    ["fee not whole", { vat, recurring: false, vatCostsCents: 12, currency: "eur" }, (b) => b.set("payment_intent_data[application_fee_amount]", "5.5")],
  ];
  for (const [label, input, change] of cases) {
    const b = body();
    change(b);
    const before = b.toString();
    assert.equal(applyEuVatLines(b, input), "refuse", label);
    assert.equal(b.toString(), before, `${label}: nothing written`);
  }
});
