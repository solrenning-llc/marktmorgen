/**
 * Review of #4572 (Claude 7, three MÉDIOs in the base PR0, `claude/adoring-mayer-gzm5l3`):
 * - consumerGate read only the main product. A paid bundle made only of calls goes on as a live service, and its
 *   checkout boxes (a download, a course) were added after the gate as lines of their own: an electronically supplied
 *   service sold to an EU consumer without VAT. The gate now reads the whole order, the boxes included.
 * - A buyer in Kosovo could never pay: the field offers XK, and the gate took every user-assigned X code for "not a
 *   country", so it asked for the billing country again on every try.
 * - The art. 63c record took any three-letter currency, and the OSS return converts minor units as hundredths: a sale
 *   in yen was declared at a hundredth of its VAT. A record is made only in a currency written in hundredths.
 * Pure; synthetic products and headers only.
 */
import { strict as assert } from "node:assert";
import { test } from "node:test";
import { BILLING_COUNTRY_NEEDED, EU_UK_REFUSED, consumerGate } from "@/lib/eu-vat-gate";
import { BILLING_COUNTRY_FIELD } from "@/lib/eu-vat-evidence";
import { euVatRecord } from "@/lib/eu-vat-record";

const download = { priceCents: 2900, file: "vault/x/y/z.pdf", link: null, keys: null, course: null, recurring: null, call: null, bundle: null, pwyw: null };
const call = { ...download, file: null, call: { minutes: 30 } };
const calls = { ...download, file: null, bundle: ["calla", "callb"] };
const members = new Map([["calla", call], ["callb", call]]);
const at = (ip: string | null, billing: string | null) => ({
  headers: new Headers(ip === null ? {} : { "x-vercel-ip-country": ip }),
  form: new URLSearchParams(billing === null ? {} : { [BILLING_COUNTRY_FIELD]: billing }),
});
const refused = { ok: false, reason: "refused", message: EU_UK_REFUSED };
const ask = { ok: false, reason: "billing", message: BILLING_COUNTRY_NEEDED };

test("(control) a bundle of calls alone goes on wherever the buyer is", () => {
  assert.deepEqual(consumerGate({ product: calls, members, ...at("DE", "DE") }), { ok: true });
});

test("a download checked in a box beside a bundle of calls is gated with the order", () => {
  assert.deepEqual(consumerGate({ product: calls, members, boxes: [{ product: download }], ...at("DE", "DE") }), refused);
  assert.deepEqual(consumerGate({ product: calls, members, boxes: [{ product: download }], ...at("US", null) }), ask);
  assert.deepEqual(consumerGate({ product: calls, members, boxes: [{ product: download }], ...at("US", "US") }), { ok: true });
});

test("a box of calls beside a bundle of calls still goes on", () => {
  assert.deepEqual(consumerGate({ product: calls, members, boxes: [{ product: call }], ...at("DE", "DE") }), { ok: true });
});

test("a box whose kind does not read is gated too", () => {
  assert.deepEqual(consumerGate({ product: calls, members, boxes: [{ product: { ...download, file: null } }], ...at("FR", "FR") }), refused);
});

test("a buyer in Kosovo can pay: XK is a country the field offers", () => {
  assert.deepEqual(consumerGate({ product: download, ...at("XK", "XK") }), { ok: true });
  assert.deepEqual(consumerGate({ product: download, ...at("US", "XK") }), { ok: true });
});

test("(control) other user-assigned codes are still not a country", () => {
  assert.deepEqual(consumerGate({ product: download, ...at("US", "XX") }), ask);
});

const sale = {
  sale: "cs_test_EuVatReview4572",
  store: "0123456789abcdef0123456789abcdef",
  supply: "ess" as const,
  service: "Digital download",
  at: 1_794_000_000,
  currency: "eur",
  vat: { priceCents: 1000, vatCents: 190, totalCents: 1190, basisPoints: 1900, country: "DE" },
  place: { kind: "eu" as const, country: "DE", evidence: { ip: "DE", billing: "DE" } },
  payments: [{ at: 1_794_000_000, cents: 1190 }],
  customerName: null,
};

test("a record is made only in a currency written in hundredths", () => {
  assert.notEqual(euVatRecord(sale), null);
  assert.notEqual(euVatRecord({ ...sale, currency: "usd" }), null);
  for (const currency of ["jpy", "krw", "kwd", "bhd", "JPY"]) assert.equal(euVatRecord({ ...sale, currency }), null, currency);
});

test("two partial refunds, each from euVatOnRefund, are both written on the record (Claude 7 on #4572)", async () => {
  const { euVatAdjustment } = await import("@/lib/eu-vat-record");
  const { euVatOnRefund } = await import("@/lib/eu-vat-refund");
  const at = 1_794_000_000;
  const priced = { ...sale, vat: { priceCents: 18_874, vatCents: 3_964, totalCents: 22_838, basisPoints: 2100, country: "NL" }, place: { kind: "eu" as const, country: "NL", evidence: { ip: "NL", billing: "NL" } }, payments: [{ at, cents: 22_838 }] };
  let record = euVatRecord(priced);
  assert.notEqual(record, null);
  const money = { priceCents: 18_874, vatCents: 3_964, totalCents: 22_838 };
  let refunded = 0;
  let vatBack = 0;
  for (const refundCents of [3_569, 17_872]) {
    const back = euVatOnRefund(money, { refundCents, refundedBeforeCents: refunded, vatBackBeforeCents: vatBack, kind: "refund" });
    assert.notEqual(back, null);
    record = euVatAdjustment(record!, { at: at + 60, taxableCents: -back!.taxableBackCents, vatCents: -back!.vatBackCents, reason: "Refund" });
    assert.notEqual(record, null, `refund of ${refundCents}`);
    refunded += refundCents;
    vatBack += back!.vatBackCents;
  }
});

test("VAT taken back with no value refunded cannot drain a sale's VAT", async () => {
  const { euVatAdjustment } = await import("@/lib/eu-vat-record");
  let record = euVatRecord(sale)!;
  let taken = 0;
  for (let i = 0; i < 50; i += 1) {
    const next = euVatAdjustment(record, { at: 1_794_000_060, taxableCents: 0, vatCents: -1, reason: "Correction" });
    if (!next) break;
    record = next;
    taken += 1;
  }
  assert.ok(taken <= 1, `VAT-only reductions accepted: ${taken}`);
});
