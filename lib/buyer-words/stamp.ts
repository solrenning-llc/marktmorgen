/**
 * The line stamped along the bottom of every page of a bought PDF or EPUB
 * (lib/pdf-stamp-line.ts), in the store's language (lib/store-language.ts).
 *
 * The PDF's standard font prints only Latin-1 letters and the ellipsis
 * (lib/pdf-stamp.ts, writable), so these words use nothing else: straight
 * apostrophes, plain spaces.
 *
 * Browser-safe: plain data and small functions, nothing from the server.
 */
import { type LanguageCode, parseLanguage } from "@/lib/store-language";

/** The whole line, from the buyer's address, the day in the store's format and the order's last characters. */
export type StampWords = (email: string, day: string, order: string) => string;

export const STAMP_WORDS: Record<LanguageCode, StampWords> = {
  en: (email, day, order) => `Sold to ${email} on ${day} · order …${order} · for personal use`,
  es: (email, day, order) => `Vendido a ${email} el ${day} · pedido …${order} · para uso personal`,
  fr: (email, day, order) => `Vendu à ${email} le ${day} · commande …${order} · pour un usage personnel`,
  de: (email, day, order) => `Verkauft an ${email} am ${day} · Bestellung …${order} · für den persönlichen Gebrauch`,
  it: (email, day, order) => `Venduto a ${email} in data ${day} · ordine …${order} · per uso personale`,
  nl: (email, day, order) => `Verkocht aan ${email} op ${day} · bestelling …${order} · voor persoonlijk gebruik`,
  pt: (email, day, order) => `Vendido a ${email} em ${day} · encomenda …${order} · para uso pessoal`,
};

export function stampWords(language: unknown): StampWords {
  return STAMP_WORDS[parseLanguage(language)];
}
