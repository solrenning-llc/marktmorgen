/**
 * What three more public reads cost in the store's own requests, taken
 * before they read (4 November 2026; the inventory of reads with no
 * ceiling, items 12, 14 and 17): a collection page, a search of the
 * community, and the one walk that puts a community's archive into its
 * search index. Each was one request (or none) whatever it read.
 *
 * Each is charged as requests of the plan's window (lib/traffic.ts,
 * takePublicRequest), each priced as a later page (tests/traffic-cost.ts,
 * laterPageCost), sized by what the request will read, known before it
 * reads it. The figures are held against what the reads cost in
 * tests/plan-cost-registry.test.ts.
 */

const MAX_UNITS = 1_000_000;
const whole = (n: number) => (Number.isFinite(n) && n > 0 ? Math.ceil(n) : 0);

/**
 * A collection page's products past the page's own request: each one's
 * listing, the listings its checkout boxes offer (MAX_BUMPS), the bundles
 * holding it, and its stock and its keys, per request.
 */
export const COLLECTION_PRODUCTS_PER_UNIT = 4;

/** The requests a collection page takes beyond the one its drawing counts (isResting). */
export function collectionUnits(products: number): number {
  return Math.min(MAX_UNITS, whole(products / COLLECTION_PRODUCTS_PER_UNIT));
}

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
/** Each check of who holds a product or an event shown on the lessons' or events' tab, which may ask Stripe (lib/community-access.ts). */
export const SEARCH_UNITS_PER_CHECK = 1;

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
