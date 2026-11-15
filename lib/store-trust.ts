/**
 * 254 [WH3]: the store page's trust line, from what the store's record already
 * says, with no read of Stripe or of anything else:
 *
 *   - that Stripe has enabled the creator's own account to take card payments,
 *     only while the store can sell (`selling`, lib/store-checkout.ts canSell:
 *     the Buy button's own test, which reads stripeChargesEnabled as
 *     lib/stripe-charges.ts keeps it), so it goes away the moment that stops
 *     being true and does not show while paid selling is closed;
 *   - since when the store is on Marktmorgen, its record's createdAt: a date
 *     that cannot be read, or one in the future, says nothing.
 *
 * Browser-safe and pure.
 */
import { LANGUAGES, parseLanguage } from "@/lib/store-language";
import { trustWords } from "@/lib/buyer-words/trust";

export function trustLines({ selling, createdAt, language }: { selling: boolean; createdAt: string; language: string }, now = Date.now()): string[] {
  const w = trustWords(language);
  const lines: string[] = [];
  if (selling) lines.push(w.payments);
  const at = /^\d{4}-\d{2}-\d{2}T/.test(createdAt) ? Date.parse(createdAt) : Number.NaN;
  if (Number.isFinite(at) && at <= now) {
    const month = new Date(at).toLocaleDateString(LANGUAGES[parseLanguage(language)].locale, { month: "long", year: "numeric", timeZone: "UTC" });
    lines.push(w.since(month));
  }
  return lines;
}
