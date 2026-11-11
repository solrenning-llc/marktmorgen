/**
 * Emails on the anniversary of a purchase and on dates the creator sets:
 * 283 [HG2], unit 1 (11 November 2026). Pure and server-safe: the rules
 * only. Nothing reads or writes the store, and nothing calls these yet; the
 * automations' send queue applies them in a later unit, inside the plan's
 * emails, checked before each send, with a one-click unsubscribe.
 *
 *   - The anniversary is the purchase's own date, already kept, 1 to
 *     MAX_ANNIVERSARY_YEARS years on, by the store's calendar (its time
 *     zone); a purchase on 29 February has its anniversary on 28 February in
 *     a year without one. No birth date is ever asked or kept.
 *   - The creator's own dates: at most MAX_STORE_DATES, real calendar dates
 *     written in full, within a year, none twice; read whole or refused.
 *   - Only a contact whose news consent is exactly "yes" gets one.
 *   - Once per contact per date and reason: onceKey names the mark the
 *     sender claims before it sends, from the contact's own key (never the
 *     address).
 *   - Unknown is never sent (rule 24).
 */
import { isTimeZone, partsIn } from "@/lib/call-setup";

/** The most years after a purchase an anniversary email may be set for. */
export const MAX_ANNIVERSARY_YEARS = 5;
/** The most dates of its own a store sets. */
export const MAX_STORE_DATES = 12;
/** How far ahead a store's date may be set, in days. */
const HORIZON_DAYS = 366;
const DAY_MS = 86_400_000;
const DATE = /^(\d{4})-(\d{2})-(\d{2})$/;

/** The years setting: 0 when off or never set, 1 to MAX_ANNIVERSARY_YEARS, null when it is not one. */
export function readAnniversaryYears(raw: unknown): number | null {
  if (raw === undefined) return 0;
  const n = typeof raw === "string" && /^\d+$/.test(raw.trim()) ? Number(raw.trim()) : raw;
  return typeof n === "number" && Number.isInteger(n) && n >= 0 && n <= MAX_ANNIVERSARY_YEARS ? n : null;
}

const pad = (n: number) => String(n).padStart(2, "0");
const text = (y: number, m: number, d: number) => `${y}-${pad(m)}-${pad(d)}`;

/** The store's own date (YYYY-MM-DD) of an instant, or null. */
function localDate(ms: number, tz: unknown): string | null {
  if (typeof ms !== "number" || !Number.isFinite(ms) || ms < 0 || !isTimeZone(tz)) return null;
  const p = partsIn(ms, tz);
  return text(p.year, p.month, p.day);
}

/** The anniversary's date by the store's calendar, `years` after the purchase; null when off or unreadable. */
export function anniversaryOn(purchasedAt: number, years: number, tz: unknown): string | null {
  if (!Number.isInteger(years) || years < 1 || years > MAX_ANNIVERSARY_YEARS) return null;
  const bought = localDate(purchasedAt, tz);
  if (!bought) return null;
  const [y, m, d] = bought.split("-").map(Number);
  const year = y + years;
  // The last day of that month in that year: 29 February becomes 28 February in a year without it.
  const last = new Date(Date.UTC(year, m, 0)).getUTCDate();
  return text(year, m, Math.min(d, last));
}

/** Whether `now` is the anniversary by the store's calendar. */
export function isAnniversaryToday(input: { purchasedAt: number; years: number; tz: unknown; now: number }): "yes" | "no" | "unknown" {
  if (input.years === 0) return "no";
  const on = anniversaryOn(input.purchasedAt, input.years, input.tz);
  const today = localDate(input.now, input.tz);
  if (!on || !today) return "unknown";
  return on === today ? "yes" : "no";
}

function dayOf(raw: unknown): number | null {
  if (typeof raw !== "string") return null;
  const m = DATE.exec(raw);
  if (!m) return null;
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const ms = Date.UTC(y, mo - 1, d);
  const back = new Date(ms);
  return back.getUTCFullYear() === y && back.getUTCMonth() === mo - 1 && back.getUTCDate() === d ? ms / DAY_MS : null;
}

/** The store's own dates, sorted, from `today` on; null when the list is not one this module would keep. */
export function readStoreDates(raw: unknown, today: string): string[] | null {
  const from = dayOf(today);
  if (from === null || !Array.isArray(raw) || raw.length > MAX_STORE_DATES) return null;
  const days = new Set<number>();
  for (const entry of raw) {
    const day = dayOf(entry);
    if (day === null || days.has(day) || day > from + HORIZON_DAYS) return null;
    days.add(day);
  }
  return [...days].filter((day) => day >= from).sort((a, b) => a - b).map((day) => new Date(day * DAY_MS).toISOString().slice(0, 10));
}

/** Only a contact whose news consent is exactly "yes". */
export function mayEmailOnDate(news: unknown): boolean {
  return news === "yes";
}

const PART = /^[A-Za-z0-9_:-]{1,128}$/;

/**
 * The mark claimed before one contact gets one date's email: by the store,
 * the contact's own key (a hash, never the address), the reason (an
 * anniversary of a product, or a store date) and the date. Null when any
 * part is not one.
 */
export function onceKey(storeId: string, contactKey: string, reason: string, date: string): string | null {
  if (![storeId, contactKey, reason].every((p) => PART.test(p)) || dayOf(date) === null) return null;
  // Only the mark's name: the unit that keeps it adds its key family and registers it.
  return `${storeId}:${contactKey}:${reason}:${date}`;
}
