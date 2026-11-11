/**
 * Dates with no marketing email in a store's automations: 383 [TB9], unit 1
 * (11 November 2026). Pure and server-safe: the rules only. Nothing reads
 * or writes the store here, and nothing calls these yet; the automations'
 * own send queue (lib/flows.ts) applies them in a later unit, without a
 * second job.
 *
 * The creator marks dates (a holiday, a launch day elsewhere, a day off).
 * A marketing email an automation would send on one of them, by the store's
 * own calendar, waits for the next date that is not marked, at the same
 * local time in the store's time zone. Daylight saving is the store's: an
 * hour the clocks skip goes to the first time that exists after it; an hour
 * that happens twice is sent once, at one of them, never before it was due.
 *
 *   - At most MAX_PAUSE_DATES dates, none further than PAUSE_HORIZON_DAYS
 *     ahead, each a real calendar date written in full (YYYY-MM-DD), none
 *     twice: read whole or refused (null). Dates already past are dropped.
 *   - At most MAX_POSTPONE_DAYS of waiting: past that the email is "held",
 *     never dropped and never sent twice; the caller keeps it until the
 *     creator unmarks a date.
 *   - A service or required email (a receipt, a sign-in link, a legal
 *     notice) is never held back by marketing dates.
 *   - Unknown is never sent (rule 24): a time zone, a list of dates, a kind
 *     of email or a time that cannot be read is "unknown".
 */
import { isTimeZone, partsIn, zonedToUtc } from "@/lib/call-setup";

/** The most dates one store marks. */
export const MAX_PAUSE_DATES = 60;
/** How far ahead a date may be marked, in days from today. */
export const PAUSE_HORIZON_DAYS = 366;
/** The longest a marketing email waits for a free date before it is held. */
export const MAX_POSTPONE_DAYS = 14;
/** How far past a skipped hour the first existing time is looked for, in minutes. */
const GAP_SEARCH_MINUTES = 180;

const DATE = /^(\d{4})-(\d{2})-(\d{2})$/;
const DAY_MS = 86_400_000;

/** A real calendar date written in full, as days since 1970, or null. */
function dayOf(text: unknown): number | null {
  if (typeof text !== "string") return null;
  const m = DATE.exec(text);
  if (!m) return null;
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const ms = Date.UTC(y, mo - 1, d);
  const back = new Date(ms);
  if (back.getUTCFullYear() !== y || back.getUTCMonth() !== mo - 1 || back.getUTCDate() !== d) return null;
  return ms / DAY_MS;
}

const textOf = (day: number) => new Date(day * DAY_MS).toISOString().slice(0, 10);

/**
 * The creator's marked dates, sorted, from `today` (YYYY-MM-DD, the store's
 * own date) on; null when the list is not one this module would keep.
 */
export function readPauseDates(raw: unknown, today: string): string[] | null {
  const from = dayOf(today);
  if (from === null || !Array.isArray(raw) || raw.length > MAX_PAUSE_DATES) return null;
  const days = new Set<number>();
  for (const entry of raw) {
    const day = dayOf(entry);
    if (day === null || days.has(day) || day > from + PAUSE_HORIZON_DAYS) return null;
    days.add(day);
  }
  return [...days].filter((day) => day >= from).sort((a, b) => a - b).map(textOf);
}

export type SendDecision = { kind: "send"; at: number } | { kind: "held" } | { kind: "unknown" };

/**
 * When an automation's email due at `at` (milliseconds) may go, given the
 * store's time zone `tz` and its marked dates: as due when its local date is
 * not marked or it is a service email; on the next free date at the same
 * local time when it is; "held" past MAX_POSTPONE_DAYS; "unknown" when
 * anything cannot be read.
 */
export function nextSendTime(input: { at: number; tz: unknown; dates: unknown; kind: unknown }): SendDecision {
  const { at, tz, dates, kind } = input;
  if (typeof at !== "number" || !Number.isFinite(at) || at < 0) return { kind: "unknown" };
  if (kind !== "marketing" && kind !== "service") return { kind: "unknown" };
  if (kind === "service") return { kind: "send", at };
  if (!isTimeZone(tz)) return { kind: "unknown" };
  const local = partsIn(at, tz);
  const today = Date.UTC(local.year, local.month - 1, local.day) / DAY_MS;
  const marked = readPauseDates(dates, textOf(today));
  if (marked === null) return { kind: "unknown" };
  const blocked = new Set(marked.map((text) => dayOf(text) as number));
  if (!blocked.has(today)) return { kind: "send", at };
  const minute = local.hour * 60 + local.minute;
  for (let ahead = 1; ahead <= MAX_POSTPONE_DAYS; ahead += 1) {
    const day = today + ahead;
    if (blocked.has(day)) continue;
    const date = new Date(day * DAY_MS);
    for (let m = minute; m <= minute + GAP_SEARCH_MINUTES && m < 24 * 60; m += 1) {
      const instant = zonedToUtc(date.getUTCFullYear(), date.getUTCMonth() + 1, date.getUTCDate(), m, tz);
      if (instant !== null && instant > at) return { kind: "send", at: instant };
    }
    return { kind: "unknown" };
  }
  return { kind: "held" };
}
