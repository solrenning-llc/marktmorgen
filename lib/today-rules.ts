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

/** What the studio read, each a count, or null when it could not be read. */
export type TodayCounts = {
  salesToday: number | null;
  salesYesterday: number | null;
  /** Revenue today and yesterday, already written in the store's currency ("$120"); null when not read. */
  revenueToday: string | null;
  revenueYesterday: string | null;
  /** Conversations with at least one unread message. */
  unreadConversations: number | null;
  bookingsToday: number | null;
  bookingsTomorrow: number | null;
  eventsToday: number | null;
  eventsTomorrow: number | null;
  toShip: number | null;
  failedRenewals: number | null;
  reviewsUnanswered: number | null;
  communityReports: number | null;
  affiliateRequests: number | null;
  questionsUnanswered: number | null;
};

export type TodayLine = { id: TodayId; words: string; permission: Permission };

export type TodayView = { kind: "lines"; lines: TodayLine[]; unread: boolean } | { kind: "nothing"; words: string };

/** Which permission each line needs: the one of the screen it leads to (lib/team-roles.ts). */
export const TODAY_PERMISSION: Record<TodayId, Permission> = {
  sales: "orders",
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
function dayPart(count: number | null, day: "today" | "yesterday" | "tomorrow", one: string, many: string, extra: string | null, extraRead: boolean): { words: string; unread: boolean } {
  if (count === null) return { words: `${many} ${day} could not be read`, unread: true };
  if (count === 0) return { words: `none ${day}`, unread: false };
  return { words: `${plural(count, one, many)} ${day}${extra ? ` (${extra})` : ""}`, unread: !extraRead };
}

/** A line over two days, or null when both are zero; with whether part of it could not be read. */
function twoDays(
  first: { count: number | null; day: "today" | "yesterday" | "tomorrow"; extra?: string | null },
  second: { count: number | null; day: "today" | "yesterday" | "tomorrow"; extra?: string | null },
  one: string,
  many: string,
): { words: string; unread: boolean } | null {
  if (first.count === 0 && second.count === 0) return null;
  // A count above zero whose figure (revenue) is expected but missing is a part not read.
  const a = dayPart(first.count, first.day, one, many, first.extra ?? null, first.extra !== null || first.extra === undefined);
  const b = dayPart(second.count, second.day, one, many, second.extra ?? null, second.extra !== null || second.extra === undefined);
  const words = `${a.words}, ${b.words}.`;
  return { words: words[0].toUpperCase() + words.slice(1), unread: a.unread || b.unread };
}

/** One count's line, or null when it is zero; a count not read says so. */
function oneCount(count: number | null, one: string, many: string, rest: string): { words: string; unread: boolean } | null {
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
      return twoDays({ count: c.bookingsToday, day: "today" }, { count: c.bookingsTomorrow, day: "tomorrow" }, "booking", "bookings");
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

/**
 * The screen for one person: the lines their role may act on, at zero
 * hidden; "Nothing needs you today" only when everything they may see was
 * read and is at zero.
 */
export function todayView(counts: TodayCounts, may: (permission: Permission) => boolean): TodayView {
  const lines: TodayLine[] = [];
  let unread = false;
  for (const id of TODAY_ORDER) {
    const permission = TODAY_PERMISSION[id];
    if (!may(permission)) continue;
    const said = line(id, counts);
    if (!said) continue;
    if (said.unread) unread = true;
    lines.push({ id, words: said.words, permission });
  }
  if (!lines.length && !unread) return { kind: "nothing", words: NOTHING_TODAY };
  return { kind: "lines", lines, unread };
}
