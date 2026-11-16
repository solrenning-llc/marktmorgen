/**
 * The line a stamped PDF carries along the bottom of every page
 * (lib/pdf-stamp.ts prints it). On its own, with no PDF library, so a page
 * that only shows the line, such as the feature page's card, reads it from
 * here. Browser-safe.
 *
 * In the store's language, with the date its way (lib/buyer-words/stamp.ts);
 * a caller that knows no store, such as that card, gets the English line.
 */
import { LANGUAGES, type LanguageCode, parseLanguage } from "@/lib/store-language";
import { stampWords } from "@/lib/buyer-words/stamp";

export function stampLine(email: string, reference: string, at: Date = new Date(), language?: LanguageCode): string {
  const code = parseLanguage(language);
  const day = at.toLocaleDateString(LANGUAGES[code].locale, { day: "numeric", month: "short", year: "numeric", timeZone: "UTC" });
  const order = reference.replace(/^(cs|pi)_(test|live)?_?/, "").slice(-6).toUpperCase();
  return stampWords(code)(email, day, order);
}
