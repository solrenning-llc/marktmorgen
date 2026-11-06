/**
 * The store's own dates: 283 [HG2], unit 2 (6 November 2026).
 *
 * A creator names a few days of the year that mean something to the store
 * (the day it opened, a holiday it marks) and writes the email for each.
 * Every year, on that day, the email goes to everyone on the store's list who
 * agreed to hear from the creator and may still be written to: it is made as
 * one of the store's own emails (lib/broadcasts.ts, createBroadcast) and sent
 * by the scheduled job like any other (lib/store-dates-send.ts). Once per
 * date per year, whatever the job does.
 *
 * Nothing about any person is asked for or kept here: no birth date, ever
 * (the owner's decision recorded in 283 [HG2]). A date is the store's own.
 *
 * Pure and browser-safe, so the studio's form and the job read the same rules.
 */
import { hasPlaceholder } from "@/lib/mail-body";

export type StoreDate = {
  /** What the creator calls it, for the studio only: never sent. */
  name: string;
  /** 1 to 12. */
  month: number;
  /** 1 to the days of that month (February 29 allowed: in other years it comes on March 1). */
  day: number;
  subject: string;
  /** The email, as the creator writes it (lib/mail-body.ts), sent as written. */
  message: string;
  /**
   * When this day was set (milliseconds): a day added after it has already
   * passed this year waits for next year, never goes out late.
   */
  since: number;
};

export type StoreDates = { on: boolean; dates: StoreDate[] };

/** How many dates a store may keep. */
export const MAX_STORE_DATES = 6;
export const MAX_DATE_NAME = 60;
/** The same as an email's subject (lib/mail.ts, MAX_SUBJECT; held in tests/hg2-store-dates.test.ts). */
export const MAX_DATE_SUBJECT = 150;
export const MAX_DATE_MESSAGE = 2_000;
/** How many days a date's email may still be made after its day: a day the job did not run is caught the next. */
export const STORE_DATE_WINDOW_DAYS = 2;

export const NO_STORE_DATES: StoreDates = { on: false, dates: [] };

export const MONTH_NAMES = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"] as const;
/** The most days each month can have (February 29 is allowed). */
export const MONTH_DAYS = [31, 29, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31] as const;

const DAY_MS = 86_400_000;

/** The date as a short key, month then day: "1106" for November 6. */
export const dateKey = (date: Pick<StoreDate, "month" | "day">): string => `${String(date.month).padStart(2, "0")}${String(date.day).padStart(2, "0")}`;

/** A month and day that exist (February 29 included). */
export function realDay(month: unknown, day: unknown): boolean {
  return Number.isInteger(month) && Number.isInteger(day) && (month as number) >= 1 && (month as number) <= 12 && (day as number) >= 1 && (day as number) <= MONTH_DAYS[(month as number) - 1];
}

/** One line: every run of spaces and control characters made one space. */
const line = (raw: unknown, max: number): string =>
  typeof raw === "string" ? raw.replace(/[\u0000-\u001f\u007f\s]+/g, " ").trim().slice(0, max).trim() : "";

/** The email as kept: line breaks kept as "\n", every other control character taken out, cut to the bound. */
function cleanMessage(raw: unknown): string {
  if (typeof raw !== "string") return "";
  return raw
    .replace(/\r\n?/g, "\n")
    .replace(/[\u0000-\u0009\u000b-\u001f\u007f]/g, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim()
    .slice(0, MAX_DATE_MESSAGE)
    .trim();
}

/** One date as stored, or null when it is not whole. */
function parseDate(raw: unknown): StoreDate | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const value = raw as Record<string, unknown>;
  const name = line(value.name, MAX_DATE_NAME);
  const subject = line(value.subject, MAX_DATE_SUBJECT);
  const message = cleanMessage(value.message);
  if (!realDay(value.month, value.day) || !name || !subject || !message) return null;
  const since = typeof value.since === "number" && Number.isSafeInteger(value.since) && value.since >= 0 ? value.since : 0;
  return { name, month: value.month as number, day: value.day as number, subject, message, since };
}

const byDay = (a: StoreDate, b: StoreDate) => a.month - b.month || a.day - b.day;

/** Whatever came back from storage, made safe to use: whole dates only, one a day, at most MAX_STORE_DATES, in calendar order; on only with one. */
export function parseStoreDates(raw: unknown): StoreDates {
  const value = raw && typeof raw === "object" && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {};
  const seen = new Set<string>();
  const dates: StoreDate[] = [];
  for (const entry of Array.isArray(value.dates) ? value.dates.slice(0, MAX_STORE_DATES * 2) : []) {
    const date = parseDate(entry);
    if (!date || seen.has(dateKey(date))) continue;
    seen.add(dateKey(date));
    dates.push(date);
    if (dates.length === MAX_STORE_DATES) break;
  }
  dates.sort(byDay);
  return { on: value.on === true && dates.length > 0, dates };
}

export type DatesRefusal = "many" | "date" | "twice" | "name" | "subject" | "message" | "placeholder" | "empty";

/**
 * What the creator sent from the studio, checked whole: every date must be
 * complete, nothing is dropped quietly. `before` keeps the time a day was
 * first set when it is still there; a day new or moved is set `now`.
 */
export function readStoreDatesInput(raw: unknown, before: StoreDates, now: number): { ok: true; value: StoreDates } | { ok: false; reason: DatesRefusal; index?: number } {
  const value = raw && typeof raw === "object" && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {};
  const list = Array.isArray(value.dates) ? value.dates : [];
  if (list.length > MAX_STORE_DATES) return { ok: false, reason: "many" };
  const kept = new Map(before.dates.map((d) => [dateKey(d), d.since]));
  const seen = new Set<string>();
  const dates: StoreDate[] = [];
  for (const [index, entry] of list.entries()) {
    const asked = entry && typeof entry === "object" && !Array.isArray(entry) ? (entry as Record<string, unknown>) : {};
    const month = typeof asked.month === "string" ? Number(asked.month) : asked.month;
    const day = typeof asked.day === "string" ? Number(asked.day) : asked.day;
    if (!realDay(month, day)) return { ok: false, reason: "date", index };
    const key = dateKey({ month: month as number, day: day as number });
    if (seen.has(key)) return { ok: false, reason: "twice", index };
    seen.add(key);
    const name = line(asked.name, MAX_DATE_NAME);
    const subject = line(asked.subject, MAX_DATE_SUBJECT);
    const message = cleanMessage(asked.message);
    if (!name) return { ok: false, reason: "name", index };
    if (!subject) return { ok: false, reason: "subject", index };
    if (!message) return { ok: false, reason: "message", index };
    // A template's part left to write is a direction, never words sent in the creator's name (lib/mail-body.ts).
    if (hasPlaceholder(subject) || hasPlaceholder(message)) return { ok: false, reason: "placeholder", index };
    dates.push({ name, month: month as number, day: day as number, subject, message, since: kept.get(key) ?? now });
  }
  if (value.on === true && !dates.length) return { ok: false, reason: "empty" };
  dates.sort(byDay);
  return { ok: true, value: { on: value.on === true, dates } };
}

/** Whether a store sends its dates' emails. */
export function storeDatesOn(store: { storeDates: StoreDates }): boolean {
  return store.storeDates.on && store.storeDates.dates.length > 0;
}

/** Where a date falls in a year, UTC midnight (February 29 comes on March 1 in other years). */
export function dayIn(date: Pick<StoreDate, "month" | "day">, year: number): number {
  return Date.UTC(year, date.month - 1, date.day);
}

/**
 * The year whose email for this date is due now, or null: from the start of
 * its day (UTC) for STORE_DATE_WINDOW_DAYS days, and only when the date was
 * set no later than that day.
 */
export function dueYear(date: StoreDate, now: number): number | null {
  const year = new Date(now).getUTCFullYear();
  for (const y of [year, year - 1]) {
    const start = dayIn(date, y);
    if (now >= start && now < start + STORE_DATE_WINDOW_DAYS * DAY_MS && date.since < start + DAY_MS) return y;
  }
  return null;
}

/** When a date's email is next made: the start of its next day (UTC) that is still ahead, or today's when it is still due. */
export function nextDay(date: StoreDate, now: number): number {
  const due = dueYear(date, now);
  if (due !== null) return dayIn(date, due);
  const year = new Date(now).getUTCFullYear();
  for (const y of [year, year + 1]) {
    const start = dayIn(date, y);
    if (start + DAY_MS > now && date.since < start + DAY_MS) return start;
  }
  return dayIn(date, year + 2);
}

/** A day as the studio writes it: "November 6". */
export function dayWords(date: Pick<StoreDate, "month" | "day">): string {
  return `${MONTH_NAMES[date.month - 1]} ${date.day}`;
}
