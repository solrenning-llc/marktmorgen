/**
 * The "Today" screen of the studio (484 [IT1], complement item 1, unit 1;
 * the owner's request of 30 October 2026, 17h58, approved at 18h00): what a
 * creator uses every day, one line each, with the number and a way straight
 * to the screen that deals with it. The rules only; the numbers come from the
 * readings the studio already makes (unit 2), and each line's address is set
 * there, where it is checked to exist. Pure and browser-safe.
 *
 *   - One line for each thing that needs the creator, each from a reading
 *     that exists: sales and revenue today and yesterday; conversations with
 *     unread messages (lib/inbox.ts counts conversations, not messages);
 *     bookings today and tomorrow; community events today and tomorrow
 *     (lib/community-events.ts); physical orders to ship; failed membership
 *     payments; reviews without an answer; community reports; affiliate
 *     requests waiting; questions the pages could not answer.
 *   - Not here, and why: "refunds asked for" has no reading of its own (a
 *     buyer's refund request reaches the inbox as a conversation, counted
 *     there); "since your last visit" has no record of a visit to count from.
 *   - A line whose number is zero is not shown.
 *   - A line is shown only to someone whose role may act on it
 *     (lib/team-roles.ts), by the permission of the screen it leads to.
 *   - A number that could not be read is never shown as zero: its part of
 *     the line says so, and the screen never says "Nothing needs you today"
 *     while one is missing.
 *   - Everything at zero, and every number read: "Nothing needs you today".
 */
import type { Permission } from "@/lib/team-roles";

export type TodayId = "sales" | "inbox" | "calls" | "events" | "ship" | "renewals" | "reviews" | "reports" | "affiliates" | "questions";

/**
 * What the studio read, each a count, or null when it could not be read.
 * A count left out (undefined) is one this screen does not read yet: its line
 * is not shown at all, and it never makes the screen say "Nothing needs you
 * today" is incomplete, nor that it could not be read.
 */
export type TodayCounts = {
  salesToday?: number | null;
  salesYesterday?: number | null;
  /** Revenue today and yesterday, already written in the store's currency ("$120"); null when not read. */
  revenueToday?: string | null;
  revenueYesterday?: string | null;
  /** Conversations with at least one unread message. */
  unreadConversations?: number | null;
  bookingsToday?: number | null;
  bookingsTomorrow?: number | null;
  eventsToday?: number | null;
  eventsTomorrow?: number | null;
  toShip?: number | null;
  failedRenewals?: number | null;
  reviewsUnanswered?: number | null;
  communityReports?: number | null;
  affiliateRequests?: number | null;
  questionsUnanswered?: number | null;
};

export type TodayLine = { id: TodayId; words: string; permission: Permission };

export type TodayView = { kind: "lines"; lines: TodayLine[]; unread: boolean } | { kind: "nothing"; words: string } | { kind: "quiet"; looked: TodayId[]; words: string };

/** Which permission each line needs: the one of the screen it leads to (lib/team-roles.ts). */
export const TODAY_PERMISSION: Record<TodayId, Permission> = {
  // The numbers, where the line leads, are shown to a role with "stats".
  sales: "stats",
  inbox: "orders",
  calls: "orders",
  events: "events",
  ship: "orders",
  renewals: "stats",
  reviews: "reviews",
  reports: "community",
  affiliates: "settings",
  questions: "products",
};

export const TODAY_ORDER: TodayId[] = ["sales", "inbox", "calls", "events", "ship", "renewals", "reviews", "reports", "affiliates", "questions"];

export const NOTHING_TODAY = "Nothing needs you today.";
export const SOME_UNREAD = "Some numbers could not be read just now, so this list may not be complete. Reload the page in a moment.";

const plural = (n: number, one: string, many: string) => `${n.toLocaleString("en-US")} ${n === 1 ? one : many}`;

/** One day's part of a two-day line: the count, "none", or that it could not be read; never a zero made up. */
function dayPart(count: number | null, day: string, none: string, one: string, many: string, extra: string | null, extraRead: boolean): { words: string; unread: boolean } {
  if (count === null) return { words: `${many} ${day} could not be read`, unread: true };
  if (count === 0) return { words: none, unread: false };
  return { words: `${plural(count, one, many)} ${day}${extra ? ` (${extra})` : ""}`, unread: !extraRead };
}

/** A line over two days, or null when both are zero; with whether part of it could not be read. */
function twoDays(
  first: { count: number | null | undefined; day: string; none?: string; extra?: string | null },
  second: { count: number | null | undefined; day: string; none?: string; extra?: string | null },
  one: string,
  many: string,
): { words: string; unread: boolean } | null {
  if (first.count === undefined && second.count === undefined) return null;
  if (first.count === 0 && second.count === 0) return null;
  // A count above zero whose figure (revenue) is expected but missing is a part not read.
  // One day read and the other left out cannot happen from one reading; it is said as not read, never as none.
  const a = dayPart(first.count ?? null, first.day, first.none ?? `none ${first.day}`, one, many, first.extra ?? null, first.extra !== null || first.extra === undefined);
  const b = dayPart(second.count ?? null, second.day, second.none ?? `none ${second.day}`, one, many, second.extra ?? null, second.extra !== null || second.extra === undefined);
  const words = `${a.words}, ${b.words}.`;
  return { words: words[0].toUpperCase() + words.slice(1), unread: a.unread || b.unread };
}

/** One count's line, or null when it is zero; a count not read says so. */
function oneCount(count: number | null | undefined, one: string, many: string, rest: string): { words: string; unread: boolean } | null {
  if (count === undefined) return null;
  if (count === null) return { words: `${many[0].toUpperCase()}${many.slice(1)} ${rest}: could not be read just now.`, unread: true };
  return count ? { words: `${plural(count, one, many)} ${rest}.`, unread: false } : null;
}

function line(id: TodayId, c: TodayCounts): { words: string; unread: boolean } | null {
  switch (id) {
    case "sales":
      return twoDays({ count: c.salesToday, day: "today", extra: c.revenueToday }, { count: c.salesYesterday, day: "yesterday", extra: c.revenueYesterday }, "sale", "sales");
    case "inbox":
      return oneCount(c.unreadConversations, "conversation", "conversations", "with unread messages in your inbox");
    case "calls":
      // Only bookings not over yet are counted, so today's part says so.
      return twoDays({ count: c.bookingsToday, day: "still to come today", none: "none left today" }, { count: c.bookingsTomorrow, day: "tomorrow" }, "booking", "bookings");
    case "events":
      return twoDays({ count: c.eventsToday, day: "today" }, { count: c.eventsTomorrow, day: "tomorrow" }, "community event", "community events");
    case "ship":
      return oneCount(c.toShip, "order", "orders", "to ship");
    case "renewals":
      return oneCount(c.failedRenewals, "membership payment", "membership payments", "that failed");
    case "reviews":
      return oneCount(c.reviewsUnanswered, "review", "reviews", "without an answer");
    case "reports":
      return oneCount(c.communityReports, "report", "reports", "in your community");
    case "affiliates":
      return oneCount(c.affiliateRequests, "affiliate request", "affiliate requests", "waiting");
    case "questions":
      return oneCount(c.questionsUnanswered, "question", "questions", "your pages could not answer");
  }
}

/** Which counts each line reads; a line whose counts are all left out is not on this screen yet. */
const READS: Record<TodayId, (keyof TodayCounts)[]> = {
  sales: ["salesToday", "salesYesterday"],
  inbox: ["unreadConversations"],
  calls: ["bookingsToday", "bookingsTomorrow"],
  events: ["eventsToday", "eventsTomorrow"],
  ship: ["toShip"],
  renewals: ["failedRenewals"],
  reviews: ["reviewsUnanswered"],
  reports: ["communityReports"],
  affiliates: ["affiliateRequests"],
  questions: ["questionsUnanswered"],
};

/** What each line is about, in a few words, for saying what the screen looked at. */
export const TODAY_TOPIC: Record<TodayId, string> = {
  sales: "sales",
  inbox: "messages",
  calls: "bookings",
  events: "community events",
  ship: "orders to ship",
  renewals: "membership payments",
  reviews: "reviews",
  reports: "community reports",
  affiliates: "affiliate requests",
  questions: "questions",
};

/**
 * The screen for one person: the lines their role may act on, at zero
 * hidden; "Nothing needs you today" only when everything they may see was
 * read and is at zero. When some lines they may see are not read on this
 * screen yet, an empty screen says only that the ones it looked at are quiet
 * ("quiet", with their topics), never that nothing needs them.
 */
export function todayView(counts: TodayCounts, may: (permission: Permission) => boolean): TodayView {
  const lines: TodayLine[] = [];
  const looked: TodayId[] = [];
  let unread = false;
  let left = false;
  for (const id of TODAY_ORDER) {
    const permission = TODAY_PERMISSION[id];
    if (!may(permission)) continue;
    if (READS[id].every((key) => counts[key] === undefined)) {
      left = true;
      continue;
    }
    looked.push(id);
    const said = line(id, counts);
    if (!said) continue;
    if (said.unread) unread = true;
    lines.push({ id, words: said.words, permission });
  }
  if (!lines.length && !unread) {
    if (!left) return { kind: "nothing", words: NOTHING_TODAY };
    return { kind: "quiet", looked, words: quietWords(looked) };
  }
  return { kind: "lines", lines, unread };
}

/** "Nothing new in sales and bookings today." for the topics looked at; empty for none, when the screen is not shown. */
export function quietWords(looked: TodayId[]): string {
  const topics = looked.map((id) => TODAY_TOPIC[id]);
  if (!topics.length) return "";
  const list = topics.length === 1 ? topics[0] : `${topics.slice(0, -1).join(", ")} and ${topics[topics.length - 1]}`;
  return `Nothing new in ${list} today.`;
}

/** A UTC day ("2026-11-02"), the day every number in the studio is counted in (lib/stats.ts). */
export const utcDay = (ms: number) => new Date(ms).toISOString().slice(0, 10);

/**
 * Sales and revenue today and yesterday from the studio's own sales reading
 * (lib/stats.ts, readSales: paid checkouts per UTC day, newest first, each at
 * what the buyer paid). Not read (null) when the reading failed. Left out
 * (no line) when the reading stopped at its last page (`partial`, which also
 * covers a PayPal reading that failed) or some sales were in another currency
 * (`elsewhere`, left out of the days): either could leave out a sale of these
 * days, and neither goes away by reloading, so no number and no "could not
 * be read" is said. `money` writes cents in the store's currency.
 */
export function salesCounts(
  reading: { state: "ok" | "error" | "none"; value: { byDay: Record<string, { sales: number; cents: number }>; partial: boolean; elsewhere: number } | null },
  money: (cents: number) => string,
  now: number,
): Pick<TodayCounts, "salesToday" | "salesYesterday" | "revenueToday" | "revenueYesterday"> {
  if (reading.state === "none" && !reading.value) return { salesToday: 0, salesYesterday: 0, revenueToday: null, revenueYesterday: null };
  const value = reading.state === "ok" ? reading.value : null;
  if (!value) return { salesToday: null, salesYesterday: null, revenueToday: null, revenueYesterday: null };
  if (value.partial || value.elsewhere > 0) return {};
  const today = value.byDay[utcDay(now)] ?? { sales: 0, cents: 0 };
  const yesterday = value.byDay[utcDay(now - 86_400_000)] ?? { sales: 0, cents: 0 };
  return { salesToday: today.sales, salesYesterday: yesterday.sales, revenueToday: `${money(today.cents)} paid`, revenueYesterday: `${money(yesterday.cents)} paid` };
}

/**
 * Bookings not over yet today, and tomorrow's (UTC), from the studio's own
 * reading of the paid calls (lib/calls.ts, paidCallsRead, where a booking
 * refunded in full is already left out and a moved one is at its new time).
 * A call going on now counts as today's, even one that started yesterday.
 * Not read (null) when the reading failed; left out (no line) when it
 * stopped at its last page while Stripe had more (`partial`), since an older
 * checkout may hold a booking for these days. One booking is one person in
 * one time: a group call with three people is three.
 */
export function bookingCounts(read: { paid: { start: number; end: number }[]; partial: boolean } | null, now: number): Pick<TodayCounts, "bookingsToday" | "bookingsTomorrow"> {
  if (!read) return { bookingsToday: null, bookingsTomorrow: null };
  if (read.partial) return {};
  const today = utcDay(now), tomorrow = utcDay(now + 86_400_000);
  let a = 0, b = 0;
  for (const call of read.paid) {
    if (!(call.end > now)) continue;
    const day = utcDay(Math.max(call.start, now));
    if (day === today) a += 1;
    else if (day === tomorrow) b += 1;
  }
  return { bookingsToday: a, bookingsTomorrow: b };
}
