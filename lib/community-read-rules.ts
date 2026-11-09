/**
 * What a search of a community costs in the store's own requests, taken
 * before it searches (4 November 2026; the inventory of reads with no
 * ceiling, item 14), and the one walk that puts a community's archive into
 * its search index. A search was one request (the page's) whatever it read,
 * and the walk none.
 *
 * Each is charged as requests of the plan's window (lib/traffic.ts,
 * takePublicRequest), each priced as a later page (tests/traffic-cost.ts,
 * laterPageCost), sized by what it will read, known before it reads it. The
 * figures are held against what the reads cost in
 * tests/plan-cost-registry.test.ts.
 */

const MAX_UNITS = 1_000_000;
const whole = (n: number) => (Number.isFinite(n) && n > 0 ? Math.ceil(n) : 0);

/**
 * One search of a community, beside the page's own request: the four
 * indexed searches and their next page, one page of results with what is
 * drawn beside it (the posts and their numbers and polls, the people, the
 * products, the events), the member's own counts.
 */
export const SEARCH_UNITS = 5;
/** The room's last messages, read whole for a search where the room is on (lib/community-chat.ts, MAX_CHAT_KEPT). */
export const SEARCH_ROOM_UNITS = 2;
/** Each of the member's conversations read for a search where messages are on (lib/community-dm.ts, SEARCH_MESSAGES of each). */
export const SEARCH_UNITS_PER_CONVERSATION = 2;
/**
 * Each check of who holds a product or an event shown on the lessons' or events' tab, which may ask Stripe
 * (lib/community-access.ts): enough units for the most one check waits on Stripe (TICKET_STRIPE_WAITS), held in
 * tests/plan-cost-registry.test.ts. It was 1 while a check read one page of checkouts and was priced at three calls,
 * fewer than it made (CX-123 rule 24, 9 November 2026).
 */
export const SEARCH_UNITS_PER_CHECK = 16;

/**
 * What one answer to "does this address hold a ticket" may read of the creator's Stripe account, at the most
 * (lib/community-access.ts, paidForAny; CX-123 rule 24, 9 November 2026). Past any of these the answer is not
 * known, never "no": the door says it could not check, and a strict door is told asking again will not tell.
 */
/** Pages of one address's checkouts read, TICKET_SESSION_PAGE_ROWS to a page, for each way the address is written (two at most). */
export const TICKET_SESSION_PAGES = 2;
/** Checkouts on one such page: Stripe's most. */
export const TICKET_SESSION_PAGE_ROWS = 100;
/** Customers the address paid as whose one-click additions are read, side by side. */
export const TICKET_CUSTOMERS = 10;
/** Pages of one such customer's payments read, TICKET_PAYMENT_PAGE_ROWS to a page: one, as before 9 November 2026. */
export const TICKET_PAYMENT_PAGES = 1;
/** Payments on one such page. */
export const TICKET_PAYMENT_PAGE_ROWS = 50;
/** Purchases whose refund or lost dispute is asked of Stripe for one answer (lib/refunds.ts purchaseRefunded, keptUnlessLost). */
export const TICKET_REFUND_CHECKS = 2;
/**
 * The calls one such question waits on, one after another, at the most: the dispute, a payment plan's invoice, its
 * payments, its first payments side by side, and their disputes side by side.
 */
export const REFUND_CHECK_WAITS = 5;
/** Every Stripe call one answer waits on, one after another, at the most: the pages of both ways of the address, the customers' pages read side by side, the refund questions. */
export const TICKET_STRIPE_WAITS = 2 * TICKET_SESSION_PAGES + TICKET_PAYMENT_PAGES + TICKET_REFUND_CHECKS * REFUND_CHECK_WAITS;

export type SearchSize = {
  /** Whether the room is searched. */
  room: boolean;
  /** How many of the member's conversations are read: at most SEARCH_CONVERSATIONS. */
  conversations: number;
};

/** The requests one search takes before it searches. */
export function searchUnits(size: SearchSize): number {
  return Math.min(MAX_UNITS, SEARCH_UNITS + (size.room ? SEARCH_ROOM_UNITS : 0) + Math.max(0, Math.floor(size.conversations)) * SEARCH_UNITS_PER_CONVERSATION);
}

/** The requests the access checks of one page of lessons or events take, before they are made. */
export function checkUnits(checks: number): number {
  return Math.min(MAX_UNITS, Math.max(0, Math.floor(checks)) * SEARCH_UNITS_PER_CHECK);
}

/** The commands of the one walk of a community's archive into its index, per request. */
export const WALK_COMMANDS_PER_UNIT = 25;
/** And the bytes it reads, per request. */
export const WALK_BYTES_PER_UNIT = 1_000_000;

/** The requests one step of the walk takes, for the commands it will send and the bytes it will read; one at the least. */
export function walkUnits(commands: number, bytes: number): number {
  return Math.min(MAX_UNITS, Math.max(1, whole(commands / WALK_COMMANDS_PER_UNIT + bytes / WALK_BYTES_PER_UNIT)));
}
