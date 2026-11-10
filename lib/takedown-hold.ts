/**
 * A link taken down for a copyright notice is held, not deleted (C6-92, 10 November 2026).
 *
 * The email to the creator promises what 17 U.S.C. § 512(g)(2)(C) asks: after a valid counter-notice, the material
 * goes back "not less than 10, nor more than 14, business days following receipt", unless the sender tells us first
 * that they went to court. A link and its picture file used to be deleted at once, so that promise could not be kept.
 * Now the link leaves the store (no page shows it, its picture's address answers "not found") and is kept on the
 * store's record, its picture under a name no page gives out, for COUNTER_NOTICE_DAYS. A counter-notice recorded in
 * that time puts back the same link at its place and the same picture at its old address, once RESTORE_AFTER_WEEKDAYS
 * full weekdays have passed since the day it came in. Without one, or once the sender says they went to court, the
 * link and its picture are deleted when the window ends, as every takedown of a link was before.
 *
 * Business days: the law does not say whose calendar. Counting weekdays only, in UTC, a holiday counted as a business
 * day would bring the put-back early; no span of 12 weekdays holds more than two US federal holidays (Christmas and
 * New Year's Day, or Juneteenth and Independence Day), so 12 full weekdays are always at least 10 business days, and
 * putting it back by the end of the 14th weekday is never later than 14. The daily job (app/api/cron/takedowns) has
 * two runs inside that span.
 *
 * Only this rule's figures and readers live here; the writes are lib/store.ts (heldLinks) and lib/takedown.ts.
 */
import { type StoreLink, parseStoreLinks } from "@/lib/store-link";

/**
 * The daily job's index (store ref -> when its held links next need a look, ms). The company's, in the nl:report:
 * family; lib/store.ts drops a store's entry when the store is deleted or closed, so no address stays in it.
 */
export const HELD_INDEX = "nl:report:held";

/** How long after a copyright takedown of a link a counter-notice is taken, the link and its picture held meanwhile. */
export const COUNTER_NOTICE_DAYS = 30;
/** Full weekdays after the day a counter-notice came in before the link goes back: at least 10 business days. */
export const RESTORE_AFTER_WEEKDAYS = 12;
/** The law's outer bound: back by the end of the 14th weekday after the day the counter-notice came in. */
export const RESTORE_BY_WEEKDAYS = 14;
/**
 * How long the page that acts on a notice keeps working after a link is held: to the end of the window, and then the
 * 14 weekdays a counter-notice recorded on its last day may take (at most 20 calendar days), with a day to spare.
 */
export const NOTICE_PAGE_AFTER_HOLD_DAYS = 21;

const DAY = 86_400_000;
const weekday = (dayStart: number) => {
  const w = new Date(dayStart).getUTCDay();
  return w !== 0 && w !== 6;
};

/** When a link whose counter-notice came in at `at` (ms) goes back: the start (UTC) of the 13th weekday after that day. */
export function restoreFrom(at: number): number {
  let day = Math.floor(at / DAY) * DAY;
  let full = 0;
  while (full < RESTORE_AFTER_WEEKDAYS) {
    day += DAY;
    if (weekday(day)) full += 1;
  }
  do day += DAY;
  while (!weekday(day));
  return day;
}

/** The end of the window a counter-notice must come in by, for a link held at `at` (ms). */
export const holdUntil = (at: number): number => at + COUNTER_NOTICE_DAYS * DAY;

/**
 * One link held after a copyright notice, on the store's record (Store.heldLinks): the link as it was, its place in
 * the list, the notice, when it was held and until when, where its picture is kept meanwhile (null when it had none),
 * and, once recorded, when the counter-notice came in and whether the sender said they went to court.
 */
export type HeldLink = {
  link: StoreLink;
  place: number;
  report: string;
  heldAt: string;
  until: string;
  picture: string | null;
  counter?: string;
  court?: true;
};

/** What is due for one held link at `now`: put back, delete, or wait until `next`. */
export function heldDue(held: HeldLink, now: number): { act: "restore" | "delete" } | { act: "wait"; next: number } {
  if (held.counter && !held.court) {
    const back = restoreFrom(Date.parse(held.counter));
    return now >= back ? { act: "restore" } : { act: "wait", next: back };
  }
  const until = Date.parse(held.until);
  return now >= until ? { act: "delete" } : { act: "wait", next: until };
}

/** The same value, whatever the order of its keys: a link read back must have lost nothing on the way. */
const canonical = (value: unknown): string =>
  JSON.stringify(value, (_key, v: unknown) => (v && typeof v === "object" && !Array.isArray(v) ? Object.fromEntries(Object.entries(v as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b))) : v));

const moment = (value: unknown): value is string => typeof value === "string" && /^\d{4}-\d{2}-\d{2}T/.test(value) && Number.isFinite(Date.parse(value));

/**
 * The held links of a stored record. An entry not in its exact shape is kept as it was stored (`raw`), never dropped
 * and never acted on: an unreadable hold is neither put back nor deleted (rule 24), and the record keeps it for a
 * person to look at.
 */
export function parseHeldLinks(raw: unknown): { held: HeldLink[]; unread: unknown[] } {
  const held: HeldLink[] = [];
  const unread: unknown[] = [];
  if (!Array.isArray(raw)) return { held, unread };
  for (const entry of raw.slice(0, 200)) {
    const v = entry && typeof entry === "object" ? (entry as Record<string, unknown>) : null;
    const [link] = v ? parseStoreLinks([v.link]) : [];
    const ok = v && link && !link.header && canonical(link) === canonical(v.link) &&
      Number.isSafeInteger(v.place) && (v.place as number) >= 0 && typeof v.report === "string" && /^[0-9a-f]{16}$/.test(v.report) &&
      moment(v.heldAt) && moment(v.until) && (v.picture === null || (typeof v.picture === "string" && v.picture.startsWith("images/"))) &&
      (v.counter === undefined || moment(v.counter)) && (v.court === undefined || v.court === true);
    if (!ok || !v || !link) {
      unread.push(entry);
      continue;
    }
    held.push({
      link, place: v.place as number, report: v.report as string, heldAt: v.heldAt as string, until: v.until as string, picture: v.picture as string | null,
      ...(v.counter ? { counter: v.counter as string } : {}), ...(v.court ? { court: true as const } : {}),
    });
  }
  return { held, unread };
}
