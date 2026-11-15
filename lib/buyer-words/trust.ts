/**
 * 254 [WH3]: the words of the store page's trust line (lib/store-trust.ts),
 * in each language a store speaks to its buyers in. Only what the store's
 * record says: never a seal, a rank, a count or Stripe's endorsement (Stripe's
 * Marks page, stripe.com/legal/marks, last updated June 12, 2023: the word
 * mark in text, truthfully, never implying endorsement or sponsorship).
 * Browser-safe: plain data.
 */
import { type LanguageCode, parseLanguage } from "@/lib/store-language";

export type TrustWords = { payments: string; since: (month: string) => string };

const WORDS: Record<LanguageCode, TrustWords> = {
  en: { payments: "Stripe has enabled this creator's own account to take card payments.", since: (month) => `On Marktmorgen since ${month}.` },
  es: { payments: "Stripe ha habilitado la cuenta propia de este creador para aceptar pagos con tarjeta.", since: (month) => `En Marktmorgen desde ${month}.` },
  fr: { payments: "Stripe a activé le compte de ce créateur pour accepter les paiements par carte.", since: (month) => `Sur Marktmorgen depuis ${month}.` },
  de: { payments: "Stripe hat das eigene Konto dieses Creators für Kartenzahlungen freigeschaltet.", since: (month) => `Seit ${month} auf Marktmorgen.` },
  it: { payments: "Stripe ha abilitato il conto di questo creatore a ricevere pagamenti con carta.", since: (month) => `Su Marktmorgen da ${month}.` },
  nl: { payments: "Stripe heeft het eigen account van deze maker ingeschakeld voor kaartbetalingen.", since: (month) => `Op Marktmorgen sinds ${month}.` },
  pt: { payments: "A Stripe ativou a conta própria deste criador para receber pagamentos com cartão.", since: (month) => `No Marktmorgen desde ${month}.` },
};

export function trustWords(language: string | undefined): TrustWords {
  return WORDS[parseLanguage(language)];
}
