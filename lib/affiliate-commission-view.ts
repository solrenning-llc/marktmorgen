import type { Credit, LineStatus } from "@/lib/affiliates";
import type { AffiliatePromotion } from "@/lib/affiliate-promotion";

export type AffiliateCommissionLine = {
  ref: string; at: number; title: string; aff: string; base: number; refunded: number;
  rate: number; commission: number; status: LineStatus; how: Credit; currency: string;
  promotion?: AffiliatePromotion | null;
};
/**
 * What the creator's list says under a held sale (lib/affiliates.ts, holdLine): why, and that it stays held. There is
 * no way in the studio to set a commission by hand, so nothing else is offered.
 */
export const HELD_PARTLY_REFUNDED = "PayPal refunded part of this payment. The amount refunded is not known here, so no commission is paid on it. It stays held.";
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
