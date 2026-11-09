/**
 * When a course's access ends, said to a buyer (24 [E7]): the date and the time in the store's language, always in
 * UTC and saying so, on the server, so the page, the email and the store say the same moment to everybody and it
 * never moves when the page is read in another time zone.
 */
import { LANGUAGES, parseLanguage } from "@/lib/store-language";
import { type Course, accessEndForSale, readCourseExact } from "@/lib/course";
import { UnknownReply } from "@/lib/redis-exact";
import { coursesWords } from "@/lib/buyer-words/courses";

/** "February 14, 2027, 8:00 AM UTC" in English; the same moment written the store's language's way. */
export function accessEndWhen(seconds: number, language: unknown): string {
  const locale = LANGUAGES[parseLanguage(language)].locale;
  const at = new Date(seconds * 1000);
  const day = new Intl.DateTimeFormat(locale, { dateStyle: "long", timeZone: "UTC" }).format(at);
  const time = new Intl.DateTimeFormat(locale, { timeStyle: "short", timeZone: "UTC" }).format(at);
  // Plain spaces: some languages' formats carry a narrow no-break space before "AM", which a sentence does not need.
  return `${day}, ${time} UTC`.replace(/[  ]/g, " ");
}

/**
 * The line the sales page says under the title before anyone pays (24 [E7]): the course's end date while it is more
 * than a checkout's lifetime ahead (lib/course.ts accessEndForSale), in the buyer's words, or null for no date, a
 * date already passed or one in its last 24 hours (whoever buys then is stamped with none and has no end).
 */
export function accessEndFact(course: Pick<Course, "accessEndsAt"> | null, language: unknown, nowSeconds?: number): string | null {
  const endsAt = course ? accessEndForSale(course, nowSeconds) : null;
  return endsAt === null ? null : coursesWords(language).accessEndsFact.replace("{when}", accessEndWhen(endsAt, language));
}

/**
 * The buy form's field that says which end the page showed (24 [E7]): the end in seconds, or "none". Only the forms
 * that draw the line send it (the course's sales page and course page); the checkout refuses a sale whose course no
 * longer has that end and stamps the one shown on the Stripe session under the same name.
 */
export const ACCESS_END_FIELD = "access_end";

/** What a buy form sends for the end it showed: "none", or the end (accessEndForSale). */
export function shownAccessEnd(course: Pick<Course, "accessEndsAt">, nowSeconds?: number): string {
  const end = accessEndForSale(course, nowSeconds);
  return end === null ? "none" : String(end);
}

/**
 * The end a buy form says it showed: undefined when the form did not send the field (it drew no date, so the sale
 * carries no end), null for "none", the end in seconds, or "bad" for anything else, which the checkout refuses.
 */
export function readShownAccessEnd(value: FormDataEntryValue | null): number | null | undefined | "bad" {
  if (value === null) return undefined;
  if (value === "none") return null;
  return typeof value === "string" && /^[1-9]\d{0,11}$/.test(value) ? Number(value) : "bad";
}

/**
 * The end a Stripe session was stamped with at checkout, or null for none (24 [E7]). Only the exact shape the
 * checkout writes counts: anything else is no end, never a guessed one (rule 24), the side that never takes a course
 * away from somebody who paid for it.
 */
export function accessEndStamp(meta: Record<string, string | undefined> | null | undefined): number | null {
  const raw = meta?.[ACCESS_END_FIELD];
  return typeof raw === "string" && /^[1-9]\d{0,11}$/.test(raw) ? Number(raw) : null;
}

/**
 * The course record as the sales page reads it to sell (24 [E7], C2 M1 on #3445): read exactly, because the end it
 * says is a term of the sale. `unread` when the reply could not be read: the page then draws no way to buy the course
 * (the buy box says buying is not available just now), never a buy box without the date. `course` null for no record.
 */
export async function readCourseForSale(id: string): Promise<{ course: Course | null; unread: boolean }> {
  try {
    return { course: await readCourseExact(id), unread: false };
  } catch (error) {
    // A reply that did not read, or Redis not answering at all: both are a term not known, so nothing is sold on it.
    if (!(error instanceof UnknownReply)) console.error("reading a course to sell it failed", error);
    return { course: null, unread: true };
  }
}
