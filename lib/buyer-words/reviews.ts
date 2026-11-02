/**
 * How long after the purchase a review was written, as a reader meets it on
 * a product's reviews (606 [WP5], unit 1), in the store's language
 * (lib/store-language.ts). Its own topic file, like lib/buyer-words/courses.ts.
 *
 * Counted from when the order was paid (lib/review-proof.ts, paidAt) to when
 * the review was first written; an edit keeps the first date, as the page
 * does. Units: the same day; days up to 13; weeks up to 8; months up to 23;
 * then years. The number and its unit are written by the browser's own
 * number formatting (Intl, "unit" style), so each language says "3 days",
 * "3 dias", "3 Tage" its own way. Every language says what English says.
 * Browser-safe.
 */
import { LANGUAGES, type LanguageCode, parseLanguage } from "@/lib/store-language";

const DAY = 86_400;

export type AfterPurchase = { unit: "same" | "day" | "week" | "month" | "year"; count: number };

/** How long after paying, from two times in seconds; null when either is unknown or the order is later. */
export function afterPurchase(paidAt: number, writtenAt: number): AfterPurchase | null {
  if (!Number.isFinite(paidAt) || !Number.isFinite(writtenAt) || paidAt <= 0 || writtenAt <= 0 || writtenAt < paidAt) return null;
  const days = Math.floor((writtenAt - paidAt) / DAY);
  if (days < 1) return { unit: "same", count: 0 };
  if (days < 14) return { unit: "day", count: days };
  if (days < 60) return { unit: "week", count: Math.floor(days / 7) };
  if (days < 730) return { unit: "month", count: Math.floor(days / 30.44) };
  return { unit: "year", count: Math.floor(days / 365.25) };
}

const SENTENCES: Record<LanguageCode, { same: string; after: (span: string) => string }> = {
  en: { same: "Written on the day of purchase", after: (span) => `Written ${span} after purchase` },
  es: { same: "Escrita el día de la compra", after: (span) => `Escrita ${span} después de la compra` },
  fr: { same: "Rédigé le jour de l'achat", after: (span) => `Rédigé ${span} après l'achat` },
  de: { same: "Am Tag des Kaufs geschrieben", after: (span) => `${span} nach dem Kauf geschrieben` },
  it: { same: "Scritta il giorno dell'acquisto", after: (span) => `Scritta ${span} dopo l'acquisto` },
  nl: { same: "Geschreven op de dag van aankoop", after: (span) => `Geschreven ${span} na de aankoop` },
  pt: { same: "Escrita no dia da compra", after: (span) => `Escrita ${span} depois da compra` },
};

/** The sentence a review carries, or "" when the purchase time is not known. */
export function afterPurchaseLine(language: unknown, paidAt: number, writtenAt: number): string {
  const span = afterPurchase(paidAt, writtenAt);
  if (!span) return "";
  const code = parseLanguage(language);
  const words = SENTENCES[code];
  if (span.unit === "same") return words.same;
  const amount = new Intl.NumberFormat(LANGUAGES[code].locale, { style: "unit", unit: span.unit, unitDisplay: "long" }).format(span.count);
  return words.after(amount);
}
