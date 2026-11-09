/**
 * When a course's access ends, said to a buyer (24 [E7]): the date and the time in the store's language, always in
 * UTC and saying so, on the server, so the page, the email and the store say the same moment to everybody and it
 * never moves when the page is read in another time zone.
 */
import { LANGUAGES, parseLanguage } from "@/lib/store-language";

/** "February 14, 2027, 8:00 AM UTC" in English; the same moment written the store's language's way. */
export function accessEndWhen(seconds: number, language: unknown): string {
  const locale = LANGUAGES[parseLanguage(language)].locale;
  const at = new Date(seconds * 1000);
  const day = new Intl.DateTimeFormat(locale, { dateStyle: "long", timeZone: "UTC" }).format(at);
  const time = new Intl.DateTimeFormat(locale, { timeStyle: "short", timeZone: "UTC" }).format(at);
  // Plain spaces: some languages' formats carry a narrow no-break space before "AM", which a sentence does not need.
  return `${day}, ${time} UTC`.replace(/[  ]/g, " ");
}
