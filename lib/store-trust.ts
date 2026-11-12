/**
 * The buyer trust card on a store page (94 [D2-BUYER-TRUST], unit 2; design in
 * docs/buyer-trust-card.md): facts the system works out about a store, never
 * typed by the creator as if they were a verification.
 *
 * Unit 2 is the first fact: the month the store was opened on Marktmorgen,
 * read from the store's own record (`createdAt`, written once when the store
 * is made and never edited). It says "open since", not "selling since": a
 * store may be open before it sells anything, and the card says only what the
 * record proves. The creator chooses to show it (StoreLook.since, off by
 * default); a record without a readable date, or with a date still to come,
 * shows nothing rather than a guess (VR 2).
 *
 * No read is added to a page view: the date is on the store record the page
 * already has. Browser-safe: plain data and small functions.
 */
import { LANGUAGES, type LanguageCode, parseLanguage } from "@/lib/store-language";

export type TrustWords = {
  /** The card's heading. */
  heading: string;
  /** The store-age line, with the month and year already in the store's language. */
  since: (monthYear: string) => string;
  /** Where the line comes from, said under it (no icon carries it). */
  sinceSource: string;
};

const en: TrustWords = { heading: "About this store", since: (m) => `Open on Marktmorgen since ${m}`, sinceSource: "From Marktmorgen's records, not typed by the creator." };
const es: TrustWords = { heading: "Sobre esta tienda", since: (m) => `Abierta en Marktmorgen desde ${m}`, sinceSource: "Según los registros de Marktmorgen, no escrito por el creador." };
const fr: TrustWords = { heading: "À propos de cette boutique", since: (m) => `Ouverte sur Marktmorgen depuis ${m}`, sinceSource: "D'après les registres de Marktmorgen, pas saisi par le créateur." };
const de: TrustWords = { heading: "Über diesen Shop", since: (m) => `Auf Marktmorgen seit ${m}`, sinceSource: "Aus den Aufzeichnungen von Marktmorgen, nicht vom Ersteller eingegeben." };
const it: TrustWords = { heading: "Su questo negozio", since: (m) => `Aperto su Marktmorgen da ${m}`, sinceSource: "Dai registri di Marktmorgen, non inserito dal creatore." };
const nl: TrustWords = { heading: "Over deze winkel", since: (m) => `Open op Marktmorgen sinds ${m}`, sinceSource: "Uit de gegevens van Marktmorgen, niet door de maker ingevuld." };
const pt: TrustWords = { heading: "Sobre esta loja", since: (m) => `Aberta na Marktmorgen desde ${m}`, sinceSource: "Dos registos da Marktmorgen, não escrito pelo criador." };

export const TRUST_WORDS: Record<LanguageCode, TrustWords> = { en, es, fr, de, it, nl, pt };

export function trustWords(language: unknown): TrustWords {
  return TRUST_WORDS[parseLanguage(language)];
}

/** One line of the card: the fact, and where it comes from. */
export type TrustFact = { key: "since"; text: string; source: string };

/**
 * The month and year a store record was made, in the store's language, or null
 * when the record has no readable date or one later than `now` (a clock or a
 * record that cannot be right is never shown as a fact).
 */
export function openedMonth(createdAt: unknown, language: unknown, now: number): string | null {
  if (typeof createdAt !== "string" || !createdAt) return null;
  const at = Date.parse(createdAt);
  if (!Number.isFinite(at) || at > now) return null;
  return new Intl.DateTimeFormat(LANGUAGES[parseLanguage(language)].locale, { month: "long", year: "numeric", timeZone: "UTC" }).format(at);
}

/** The facts the card shows for this store, in order; empty when there is none to show, so no card is drawn. */
export function trustFacts(
  store: { createdAt: unknown; language: unknown; look: { since?: boolean } },
  now: number = Date.now(),
): TrustFact[] {
  const facts: TrustFact[] = [];
  if (store.look.since === true) {
    const month = openedMonth(store.createdAt, store.language, now);
    if (month) {
      const w = trustWords(store.language);
      facts.push({ key: "since", text: w.since(month), source: w.sinceSource });
    }
  }
  return facts;
}
