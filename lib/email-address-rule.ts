import { type LanguageCode, parseLanguage } from "@/lib/store-language";

/**
 * The server's address rule (lib/auth.ts EMAIL_PATTERN, without the anchors a
 * browser adds), for the `pattern` of every email input, so the browser
 * refuses before sending what the server would refuse after: type=email alone
 * takes "dana@acme", and a plain form's answer page cannot give back what was
 * typed (WCAG 3.3.1, 3.3.7). Written out here, not imported, so a browser
 * bundle takes none of the server's code; tests/email-field-pattern.test.ts
 * and tests/email-pattern-everywhere.test.ts keep the two equal and every
 * email input on the site on it.
 */
export const EMAIL_ADDRESS_RULE = "[^\\s@]+@[^\\s@]+\\.[^\\s@]+";

/** What the browser says beside its own words when the pattern refuses, in the store's language. */
const WHOLE_ADDRESS: Record<LanguageCode, string> = {
  en: "Type the whole address, like name@example.com",
  es: "Escribe la dirección completa, como name@example.com",
  fr: "Saisissez l’adresse complète, par exemple name@example.com",
  de: "Geben Sie die vollständige Adresse ein, etwa name@example.com",
  it: "Scrivi l’indirizzo completo, come name@example.com",
  nl: "Typ het volledige adres, zoals name@example.com",
  pt: "Escreva o endereço completo, como name@example.com",
};

/** The `title` an email input carries beside EMAIL_ADDRESS_RULE: the store's language, English in the studio and on the site. */
export function wholeAddress(language?: string | null): string {
  return WHOLE_ADDRESS[parseLanguage(language)];
}
