/**
 * EU VAT under art. 9a, part 2 of the build, unit 7a: what of the VAT held in the platform's fee goes back when a sale
 * is refunded (docs/eu-vat-article-9a.md, "The margin consequence", point 1; "The code that would be needed", point 5).
 *
 *   - a refund gives back the VAT of what is refunded, in proportion, the last refund exactly what is left, and the
 *     same amount is a negative adjustment of the sale's art. 63c record (it reduces the OSS return);
 *   - a lost dispute gives nothing back (the reading used: no Member State relief), and records nothing;
 *   - never more than the sale's VAT in all, never for an amount that is not a whole positive number.
 * Pure; nothing is sent.
 */
import { strict as assert } from "node:assert";
import { test } from "node:test";
import { euVatOnRefund } from "@/lib/eu-vat-refund";

const sale = { priceCents: 1000, vatCents: 190, totalCents: 1190 };

test("a full refund gives back all the VAT, as one adjustment", () => {
  assert.deepEqual(euVatOnRefund(sale, { refundCents: 1190, refundedBeforeCents: 0, vatBackBeforeCents: 0, kind: "refund" }), { vatBackCents: 190, taxableBackCents: 1000 });
});

test("partial refunds give back VAT in proportion, the last exactly what is left", () => {
  const first = euVatOnRefund(sale, { refundCents: 595, refundedBeforeCents: 0, vatBackBeforeCents: 0, kind: "refund" });
  assert.deepEqual(first, { vatBackCents: 95, taxableBackCents: 500 });
  const second = euVatOnRefund(sale, { refundCents: 595, refundedBeforeCents: 595, vatBackBeforeCents: 95, kind: "refund" });
  assert.deepEqual(second, { vatBackCents: 95, taxableBackCents: 500 });
  // Three uneven parts still add up exactly to the whole.
  let vat = 0, taxable = 0, refunded = 0;
  for (const part of [400, 400, 390]) {
    const back = euVatOnRefund(sale, { refundCents: part, refundedBeforeCents: refunded, vatBackBeforeCents: vat, kind: "refund" })!;
    vat += back.vatBackCents;
    taxable += back.taxableBackCents;
    refunded += part;
  }
  assert.deepEqual([vat, taxable], [190, 1000]);
});

test("a lost dispute gives nothing back", () => {
  assert.deepEqual(euVatOnRefund(sale, { refundCents: 1190, refundedBeforeCents: 0, vatBackBeforeCents: 0, kind: "dispute-lost" }), { vatBackCents: 0, taxableBackCents: 0 });
});

test("more than was charged, a broken amount or a sale that does not add up is refused", () => {
  for (const input of [
    { refundCents: 1191, refundedBeforeCents: 0, vatBackBeforeCents: 0, kind: "refund" as const },
    { refundCents: 600, refundedBeforeCents: 600, vatBackBeforeCents: 96, kind: "refund" as const },
    { refundCents: 0, refundedBeforeCents: 0, vatBackBeforeCents: 0, kind: "refund" as const },
    { refundCents: 1.5, refundedBeforeCents: 0, vatBackBeforeCents: 0, kind: "refund" as const },
    { refundCents: 100, refundedBeforeCents: 0, vatBackBeforeCents: 191, kind: "refund" as const },
  ]) assert.equal(euVatOnRefund(sale, input), null, JSON.stringify(input));
  assert.equal(euVatOnRefund({ ...sale, totalCents: 1191 }, { refundCents: 100, refundedBeforeCents: 0, vatBackBeforeCents: 0, kind: "refund" }), null);
});
