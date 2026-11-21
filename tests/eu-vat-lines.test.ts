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

// 793 [IV3], owner's decision OWNER-20261121-1529-ART9A-PENDING-DECISIONS, item 2 (c) and (d).
const lineTotal = (b: URLSearchParams): number => {
  let sum = 0;
  for (const [key, value] of b) {
    const at = /^line_items\[(\d+)\]\[price_data\]\[unit_amount\]$/.exec(key);
    if (at) sum += Number(value) * Number(b.get(`line_items[${at[1]}][quantity]`));
  }
  return sum;
};

test("(d) no commission on tax: the share's base is written as the goods before the VAT line", () => {
  const b = body();
  assert.equal(applyEuVatLines(b, { vat, recurring: false, vatCostsCents: 12, currency: "eur" }), "ok");
  // The settlement reads the base from the payment (lib/share-settle.ts); without it, it would take the checkout's total
  // less Stripe's own tax, and the VAT line is not Stripe's tax, so the share would be worked out on the VAT too.
  assert.equal(b.get("payment_intent_data[metadata][share_base]"), "1000");
});

test("(d) a cart: the base is every line before the VAT, quantity included", () => {
  const b = body();
  b.set("line_items[1][price_data][unit_amount]", "250");
  b.set("line_items[1][price_data][currency]", "eur");
  b.set("line_items[1][quantity]", "2");
  const cart = { ...vat, priceCents: 1500, vatCents: 285, totalCents: 1785 };
  assert.equal(applyEuVatLines(b, { vat: cart, recurring: false, vatCostsCents: 12, currency: "eur" }), "ok");
  assert.equal(b.get("payment_intent_data[metadata][share_base]"), "1500");
  assert.equal(b.get("line_items[2][price_data][unit_amount]"), "285");
});

test("(d) the share part of the fee is never raised: the fee grows by exactly the VAT and its costs", () => {
  for (const share of ["0", "50", "625"]) {
    const b = body();
    b.set("payment_intent_data[application_fee_amount]", share);
    assert.equal(applyEuVatLines(b, { vat, recurring: false, vatCostsCents: 12, currency: "eur" }), "ok");
    assert.equal(Number(b.get("payment_intent_data[application_fee_amount]")) - Number(share), 190 + 12);
  }
});

test("(c) no card surcharge: the buyer pays the price and the VAT, never the costs of receiving it", () => {
  const b = body();
  const before = lineTotal(b);
  const linesBefore = [...b.keys()].filter((key) => key.endsWith("[quantity]")).length;
  assert.equal(applyEuVatLines(b, { vat, recurring: false, vatCostsCents: 12, currency: "eur" }), "ok");
  assert.equal(lineTotal(b), before + vat.vatCents);
  assert.equal([...b.keys()].filter((key) => key.endsWith("[quantity]")).length, linesBefore + 1);
  for (const [key, value] of b) {
    if (/\[product_data\]\[name\]$/.test(key)) assert.doesNotMatch(value, /fee|surcharge|card|processing|cost/i, key);
  }
});

test("a line whose amount or quantity cannot be read refuses: the base would be unknown", () => {
  for (const [key, value] of [["line_items[0][price_data][unit_amount]", "x"], ["line_items[0][quantity]", "0"], ["line_items[0][quantity]", ""]] as const) {
    const b = body();
    b.set(key, value);
    const before = b.toString();
    assert.equal(applyEuVatLines(b, { vat, recurring: false, vatCostsCents: 12, currency: "eur" }), "refuse", `${key}=${value}`);
    assert.equal(b.toString(), before);
  }
});

test("a body with a discount or a promotion box refuses: the share's base would be the price before the discount (Claude 5's MEDIUM on #5048)", () => {
  for (const [key, value] of [["discounts[0][coupon]", "co_X"], ["discounts[0][promotion_code]", "promo_X"], ["allow_promotion_codes", "true"]] as const) {
    const b = body();
    b.set(key, value);
    const before = b.toString();
    assert.equal(applyEuVatLines(b, { vat, recurring: false, vatCostsCents: 12, currency: "eur" }), "refuse", key);
    assert.equal(b.toString(), before, `${key}: nothing written`);
    assert.equal(b.get("payment_intent_data[metadata][share_base]"), null);
  }
});
