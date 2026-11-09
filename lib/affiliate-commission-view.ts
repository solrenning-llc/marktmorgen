import type { Credit, LineStatus } from "@/lib/affiliates";
import type { AffiliatePromotion } from "@/lib/affiliate-promotion";

export type AffiliateCommissionLine = {
  ref: string; at: number; title: string; aff: string; base: number; refunded: number;
  rate: number; commission: number; status: LineStatus; how: Credit; currency: string;
  promotion?: AffiliatePromotion | null;
};
/**
 * What the creator's list says under a held sale (lib/affiliates.ts, holdLine): why, promising nothing (the amount
 * refunded is never read). There is no way in the studio to set a commission by hand, so nothing else is offered.
 */
export const HELD_PARTLY_REFUNDED = "PayPal refunded part of this payment. The amount refunded can't be seen here, so this sale earns nothing.";
/** And under a commission paid before PayPal refunded part of the sale (lib/affiliates.ts, paidBeforeHold). */
export const PAID_PARTLY_REFUNDED = "This commission was paid before PayPal refunded part of the payment. The amount refunded can't be seen here, so nothing is taken back from later commissions.";
/**
 * What a commission line shows as its amount: the word for held (`held`, in the reader's language) for a sale held
 * because PayPal refunded part of it (lib/affiliates.ts, holdLine), never an amount it does not earn; otherwise its
 * commission. The creator's list and the affiliate's page both draw it from here.
 */
export function commissionShown(line: { status: string; commission: number; currency: string }, money: (cents: number, currency: string) => string, held: string): string {
  return line.status === "held" ? held : money(line.commission, line.currency);
}
/** Displayed commission records, never unique purchases; do not combine currencies. */
export function affiliateCreditGroups(lines: readonly AffiliateCommissionLine[]) {
  const groups = new Map<string, { how: Credit; currency: string; records: number; commission: number | null }>();
  for (const line of lines) {
    if (!Number.isSafeInteger(line.commission) || line.commission <= 0) continue;
    const currency = line.currency.toLowerCase();
    const key = JSON.stringify([line.how, currency]);
    const group = groups.get(key) ?? { how: line.how, currency, records: 0, commission: 0 };
    group.records += 1;
    const sum = group.commission === null ? null : group.commission + line.commission;
    group.commission = sum !== null && Number.isSafeInteger(sum) ? sum : null;
    groups.set(key, group);
  }
  return [...groups.values()];
}
export function affiliateLineScope(loaded: number, total: unknown): { total: number | null; partial: boolean | null } {
  if (typeof total !== "number" || !Number.isSafeInteger(total) || total < loaded || total < 0) return { total: null, partial: null };
  return { total, partial: total > loaded };
}
