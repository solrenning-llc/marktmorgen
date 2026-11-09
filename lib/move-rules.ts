/**
 * Moving members from another platform (added 12 October 2026): the plain
 * rules, browser-safe. What is kept and sent is in lib/move-members.ts.
 *
 * A membership cannot be handed over the way a download can: it is a
 * subscription, and a subscription is a card being charged. So nobody is
 * given a membership here. Each member the creator brings over gets their own
 * link to keep it, and keeping it is an ordinary checkout on the creator's
 * own Stripe account, with one difference: the card is taken now and first
 * charged on the day the membership would have renewed on the old platform,
 * the date the creator's file gives. They paid there up to that day, so they
 * pay here from that day, never twice for the same weeks. From the moment
 * they keep it, it is a membership like any other, opening what it opens.
 *
 * The creator stops the renewals on the old platform themselves; the studio
 * says so before the import starts.
 */

/** Members one import may bring, the same as past buyers. */
export const MAX_MOVED_MEMBERS = 20_000;
/**
 * Stripe takes a checkout's first charge date only this far ahead (Checkout
 * asks for at least 48 hours, and two more are kept for a page left open): a
 * renewal sooner than that is first charged this long after the checkout,
 * which is after the renewal date, never before it.
 */
export const MIN_DEFER_SECONDS = 50 * 3_600;
/** A renewal further away than this is not a renewal date anybody exports: the row is refused. */
export const MAX_AHEAD_DAYS = 400;
/** The one reminder goes this many days before the first charge date, to those who have not kept it yet. */
export const REMIND_DAYS_BEFORE = 3;
/**
 * Hours, from when it was due, that the reminder is tried again for while
 * whether the member kept their membership cannot be read (lib/imports.ts,
 * sendMoveReminders). A Stripe outage is most often over within a few hours;
 * an answer still unknown after that is taken as one that stays unknown (an
 * address with more customers than lib/move-members.ts reads, a customer with
 * more than a page of subscriptions), and the reminder is dropped, never sent:
 * at most REMIND_RETRY_HOURS + 1 tries, each at most two customer lists and
 * KEPT_CUSTOMERS_MAX subscription lists at Stripe.
 */
export const REMIND_RETRY_HOURS = 6;
/** A member's link works until this long after their renewal date, and never less than this long after it was sent. */
export const LINK_DAYS = 30;

/**
 * Months as the stores' seven languages write them, without accents: a
 * file exported in any of them is read, by the whole word or its first
 * letters ("nov", "dez", "okt", "giu").
 */
const MONTH_NAMES: string[][] = [
  ["january", "enero", "janvier", "januar", "janner", "gennaio", "januari", "janeiro"],
  ["february", "febrero", "fevrier", "februar", "febbraio", "februari", "fevereiro"],
  ["march", "marzo", "mars", "marz", "maart", "mrt", "marco"],
  ["april", "abril", "avril", "aprile"],
  ["may", "mayo", "mai", "maggio", "mei", "maio"],
  ["june", "junio", "juin", "juni", "giugno", "junho"],
  ["july", "julio", "juillet", "juli", "luglio", "julho"],
  ["august", "agosto", "aout", "augustus"],
  ["september", "septiembre", "setiembre", "septembre", "settembre", "setembro"],
  ["october", "octubre", "octobre", "oktober", "ottobre", "outubro"],
  ["november", "noviembre", "novembre", "novembro"],
  ["december", "diciembre", "decembre", "dezember", "dicembre", "dezembro"],
];

/** The month a word names, 1 to 12, or 0 when it names none, or could name two. */
function monthOf(word: string): number {
  if (word.length < 3) return 0;
  const found = new Set<number>();
  MONTH_NAMES.forEach((names, i) => {
    if (names.some((name) => name.startsWith(word))) found.add(i + 1);
  });
  return found.size === 1 ? [...found][0] : 0;
}

function at(year: number, month: number, day: number): number | null {
  if (year < 2000 || year > 2100 || month < 1 || month > 12 || day < 1 || day > 31) return null;
  const ms = Date.UTC(year, month - 1, day, 12);
  const back = new Date(ms);
  // "February 30" is not a day.
  if (back.getUTCMonth() !== month - 1 || back.getUTCDate() !== day) return null;
  return Math.floor(ms / 1000);
}

/** How a file writes a date that is all numbers: the month first (11/03/2026 is Nov 3) or the day first (Mar 11). */
export type DateOrder = "mdy" | "dmy";

export type ReadDate = { ok: true; at: number } | { ok: false; reason: "empty" | "unreadable" | "ambiguous" | "order" };

/** A time after the date, as exports add one: " 14:20", " 2:20 PM", "T14:20:00Z". */
const TIME = /(?:[ T]\d{1,2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:\s?[ap]\.?m\.?)?(?:\s?(?:z|utc|gmt|[+-]\d{2}:?\d{2}))?)$/i;

/**
 * A renewal date as another platform exports it, as noon UTC that day, in
 * seconds. Read:
 *
 *   - the year first: "2026-11-03", "2026/11/03", with or without a time;
 *   - the month in letters, in any of the seven languages, whole or cut
 *     short: "Nov 3, 2026", "3 November 2026", "3-Nov-26", "3. November
 *     2026", "3 de novembro de 2026";
 *   - all numbers with the year last: "11/23/2026" and "23/11/2026" can only
 *     be read one way. "04/05/2026" could be April or May: it is read only
 *     by `order`, which the creator chooses for the whole file, and refused
 *     when none was chosen. A date that does not fit the order chosen is
 *     refused too, since the file then writes dates two ways.
 */
export function readRenewal(raw: string, order: DateOrder | "" = ""): ReadDate {
  const text = raw.trim().replace(/\s+/g, " ");
  if (!text) return { ok: false, reason: "empty" };
  const date = text.replace(TIME, "").trim();
  const when = (year: number, month: number, day: number): ReadDate => {
    const found = at(year, month, day);
    return found ? { ok: true, at: found } : { ok: false, reason: "unreadable" };
  };

  let m = date.match(/^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})$/);
  if (m) return when(Number(m[1]), Number(m[2]), Number(m[3]));

  m = date.match(/^(\d{1,2})[-/.](\d{1,2})[-/.](\d{4}|\d{2})$/);
  if (m) {
    const a = Number(m[1]);
    const b = Number(m[2]);
    const year = m[3].length === 2 ? 2000 + Number(m[3]) : Number(m[3]);
    if (order) {
      const [month, day] = order === "mdy" ? [a, b] : [b, a];
      return month > 12 ? { ok: false, reason: "order" } : when(year, month, day);
    }
    if (a > 12 && b <= 12) return when(year, b, a);
    if (b > 12 && a <= 12) return when(year, a, b);
    if (a === b) return when(year, a, b);
    return { ok: false, reason: a <= 12 && b <= 12 ? "ambiguous" : "unreadable" };
  }

  // The month in letters: the words and numbers, whatever stands between them.
  const words = date
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/\b(?:de|del|of|the)\b/g, " ")
    .replace(/(\d+)(?:st|nd|rd|th|er|o|a|º|ª)(?![a-z])/g, "$1")
    .split(/[\s,./-]+/)
    .filter(Boolean);
  if (words.length !== 3) return { ok: false, reason: "unreadable" };
  const lettered = words.filter((w) => /^[a-z]+$/.test(w));
  const numbers = words.filter((w) => /^\d+$/.test(w));
  if (lettered.length !== 1 || numbers.length !== 2) return { ok: false, reason: "unreadable" };
  const month = monthOf(lettered[0]);
  if (!month) return { ok: false, reason: "unreadable" };
  // The year is the number of four digits, or, in "3-Nov-26", the last.
  const four = numbers.filter((n) => n.length === 4);
  let year: number;
  let day: number;
  if (four.length === 1) {
    year = Number(four[0]);
    day = Number(numbers.find((n) => n !== four[0]) ?? numbers[0]);
  } else if (four.length === 0 && words[2] === numbers[1] && numbers[1].length === 2) {
    year = 2000 + Number(numbers[1]);
    day = Number(numbers[0]);
  } else {
    return { ok: false, reason: "unreadable" };
  }
  if (String(day).length > 2) return { ok: false, reason: "unreadable" };
  return when(year, month, day);
}

/**
 * What a file's dates say about their order, read before anything is sent:
 * whether any could be read two ways, and which order the others prove,
 * when they prove one ("23/11/2026" proves the day comes first). Both orders
 * proved means the file writes dates two ways.
 */
export function datesInFile(values: string[]): { twoWays: boolean; proves: DateOrder | null; mixed: boolean } {
  let twoWays = false;
  const proved = new Set<DateOrder>();
  for (const value of values) {
    const read = readRenewal(value);
    if (!read.ok && read.reason === "ambiguous") twoWays = true;
    const m = value.trim().replace(TIME, "").trim().match(/^(\d{1,2})[-/.](\d{1,2})[-/.](\d{4}|\d{2})$/);
    if (m && read.ok) {
      if (Number(m[1]) > 12) proved.add("dmy");
      if (Number(m[2]) > 12) proved.add("mdy");
    }
  }
  return { twoWays, proves: proved.size === 1 ? [...proved][0] : null, mixed: proved.size > 1 };
}

/** A date read from a file, with the month in letters, as the studio shows it back to be checked: "Nov 3, 2026". */
export function letteredDate(seconds: number): string {
  return new Date(seconds * 1000).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric", timeZone: "UTC" });
}

/**
 * When the first payment here is taken, in seconds: the renewal date, or,
 * when that is closer than Stripe can wait for, the soonest it can — never
 * before the renewal date, so nobody is charged early. Null when the date
 * has passed: the payment is due, and taken at checkout.
 */
export function firstChargeAt(renews: number, now = Date.now()): number | null {
  const today = Math.floor(now / 1000);
  if (renews <= today) return null;
  return Math.max(renews, today + MIN_DEFER_SECONDS);
}

/** When the one reminder goes, in seconds, or null when there is no time left for one to help. */
export function reminderAt(renews: number, now = Date.now()): number | null {
  const when = renews - REMIND_DAYS_BEFORE * 86_400;
  return when - Math.floor(now / 1000) >= 86_400 ? when : null;
}

/**
 * When a reminder that could not be sent is tried again, in seconds: an hour
 * from now, while that is within REMIND_RETRY_HOURS of when it was due and
 * before the renewal date. Null when it is given up.
 */
export function remindAgainAt(renews: number, now = Date.now()): number | null {
  const next = Math.floor(now / 1000) + 3_600;
  const due = renews - REMIND_DAYS_BEFORE * 86_400;
  return next <= due + REMIND_RETRY_HOURS * 3_600 && next < renews ? next : null;
}

/** How long a member's link is kept, in seconds from now. */
export function linkSeconds(renews: number, now = Date.now()): number {
  return Math.max(LINK_DAYS * 86_400, renews + LINK_DAYS * 86_400 - Math.floor(now / 1000));
}

/** When a moved membership's first payment is taken, from its checkout's metadata; 0 for none. */
export function firstCharge(metadata: Record<string, string> | null | undefined): number {
  if (metadata?.moved !== "yes") return 0;
  const when = Number(metadata.first_charge);
  return Number.isInteger(when) && when > 0 ? when : 0;
}
