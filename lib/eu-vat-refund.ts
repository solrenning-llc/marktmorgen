/**
 * EU VAT under art. 9a, part 2 of the build, unit 7a: what of the VAT held in the platform's fee goes back when an EU
 * sale is refunded (docs/eu-vat-article-9a.md, "The margin consequence", point 1; "The code that would be needed",
 * point 5). Pure; nothing is sent. Store sales are refunded by the creator on their own Stripe account (direct
 * charges), so the buyer gets the VAT back from the creator, and the VAT part of the platform's fee goes back to the
 * creator by the fee's own refund (lib/share-settle.ts, when it is taught this). The same amount is a negative
 * adjustment of the sale's art. 63c record (lib/eu-vat-record.ts, euVatAdjustment), which reduces the OSS return.
 *
 *   refund        the VAT of what is refunded, in proportion to the amount charged, counted on the running total so
 *                 the last refund gives back exactly what is left (rounded half up at each running total);
 *   dispute-lost  nothing: the reading used is that no Member State relieves VAT on a lost dispute.
 * Never more than the sale's VAT in all; null for anything that does not add up.
 */
const whole = (value: unknown): value is number => typeof value === "number" && Number.isSafeInteger(value);

/** `part` of `whole` in proportion to `share` / `of`, rounded half up, in integers. */
function proportion(part: number, share: number, of: number): number | null {
  const product = part * share;
  if (!Number.isSafeInteger(product)) return null;
  return Math.floor((2 * product + of) / (2 * of));
}

export function euVatOnRefund(
  sale: { priceCents: number; vatCents: number; totalCents: number },
  input: { refundCents: number; refundedBeforeCents: number; vatBackBeforeCents: number; kind: "refund" | "dispute-lost" },
): { vatBackCents: number; taxableBackCents: number } | null {
  if (!sale || !whole(sale.priceCents) || !whole(sale.vatCents) || !whole(sale.totalCents)) return null;
  if (sale.priceCents < 0 || sale.vatCents < 0 || sale.totalCents <= 0 || sale.totalCents !== sale.priceCents + sale.vatCents) return null;
  if (!whole(input.refundCents) || input.refundCents <= 0 || !whole(input.refundedBeforeCents) || input.refundedBeforeCents < 0) return null;
  if (!whole(input.vatBackBeforeCents) || input.vatBackBeforeCents < 0 || input.vatBackBeforeCents > sale.vatCents) return null;
  const after = input.refundedBeforeCents + input.refundCents;
  if (after > sale.totalCents) return null;
  if (input.kind === "dispute-lost") return { vatBackCents: 0, taxableBackCents: 0 };
  if (input.kind !== "refund") return null;
  const vatAfter = proportion(sale.vatCents, after, sale.totalCents);
  const taxableAfter = proportion(sale.priceCents, after, sale.totalCents);
  const taxableBefore = proportion(sale.priceCents, input.refundedBeforeCents, sale.totalCents);
  if (vatAfter === null || taxableAfter === null || taxableBefore === null) return null;
  const vatBackCents = vatAfter - input.vatBackBeforeCents;
  const taxableBackCents = taxableAfter - taxableBefore;
  if (vatBackCents < 0 || taxableBackCents < 0) return null;
  return { vatBackCents, taxableBackCents };
}
