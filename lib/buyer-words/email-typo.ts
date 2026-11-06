/**
 * The "Did you mean …?" line under an email field (lib/email-typo.ts), in
 * each language a store can speak. The site's own pages use the English one.
 *
 * Browser-safe: plain data and small functions, nothing from the server.
 */
import { type LanguageCode, parseLanguage } from "@/lib/store-language";

export type EmailTypoWords = {
  /** The question, with the whole address it would become. */
  didYouMean: (address: string) => string;
  /** The button that puts it in the field, with the address, so its name says what it does. */
  use: (address: string) => string;
  /** That the typed address can still be sent as it is. */
  keep: string;
};

const en: EmailTypoWords = {
  didYouMean: (address) => `Did you mean ${address}?`,
  use: (address) => `Use ${address}`,
  keep: "If what you typed is right, keep it.",
};

const es: EmailTypoWords = {
  didYouMean: (address) => `¿Querías decir ${address}?`,
  use: (address) => `Usar ${address}`,
  keep: "Si lo que escribiste está bien, déjalo así.",
};

const fr: EmailTypoWords = {
  didYouMean: (address) => `Vouliez-vous dire ${address}\u00a0?`,
  use: (address) => `Utiliser ${address}`,
  keep: "Si ce que vous avez saisi est correct, gardez-le.",
};

const de: EmailTypoWords = {
  didYouMean: (address) => `Meinten Sie ${address}?`,
  use: (address) => `${address} verwenden`,
  keep: "Wenn Ihre Eingabe stimmt, lassen Sie sie so.",
};

const it: EmailTypoWords = {
  didYouMean: (address) => `Intendevi ${address}?`,
  use: (address) => `Usa ${address}`,
  keep: "Se quello che hai scritto è giusto, lascialo così.",
};

const nl: EmailTypoWords = {
  didYouMean: (address) => `Bedoelde je ${address}?`,
  use: (address) => `${address} gebruiken`,
  keep: "Klopt wat je hebt getypt, laat het dan zo.",
};

const pt: EmailTypoWords = {
  didYouMean: (address) => `Queria dizer ${address}?`,
  use: (address) => `Usar ${address}`,
  keep: "Se o que escreveu está certo, deixe-o como está.",
};

export const EMAIL_TYPO_WORDS: Record<LanguageCode, EmailTypoWords> = { en, es, fr, de, it, nl, pt };

export function emailTypoWords(language: unknown): EmailTypoWords {
  return EMAIL_TYPO_WORDS[parseLanguage(language)];
}
