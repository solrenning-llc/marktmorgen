/**
 * What one opening of the orders page pays for, and how (MR, 4 November 2026).
 *
 * An opening with a link takes ORDERS_OPEN_UNITS of the store's public
 * requests on the buyers' side (lib/traffic.ts) before anything is read. They
 * pay for what every opening may cost whatever the buyer has: the page held
 * for as long as it may run (ORDERS_OPEN_SECONDS, the page's maxDuration,
 * which bounds every call to the creator's Stripe account waited on, however
 * many), the link's grant, what waits on the buyer, the Discord server read,
 * and the page sent on. Everything read past that, in proportion to what the
 * buyer has (each listing, pre-order, package, bundle line, booking, room,
 * podcast feed and license key), is taken from the same requests through an
 * OrdersMeter before it is read, ORDERS_UNIT_COMMANDS commands a request, a
 * listing read as ORDERS_LISTING_COMMANDS. When the store has no room left,
 * nothing more is read and the page says it cannot show the purchases now.
 * tests/plan-cost-registry.ts prices both (ORDERS_OPEN_READ, line
 * public-requests) and tests/plan-cost-registry.test.ts holds the units above
 * what they stand for.
 */
export const ORDERS_OPEN_UNITS = 12;
/** How long one opening may run at the most: the page's maxDuration (app/[handle]/orders/page.tsx). */
export const ORDERS_OPEN_SECONDS = 30;
/** Commands every opening may make besides its metered reads: the grant, what waits (four, and one for each of WAITING_SHOWN agreements, lib/buyer-waiting.ts), the Discord server and its roles (tests/orders-open.test.ts holds it). */
export const ORDERS_OPEN_COMMANDS = 17;
/** Commands one public request pays for when the meter takes it, each with its few hundred bytes. */
export const ORDERS_UNIT_COMMANDS = 25;
/** A listing read counted in commands: the command, and the most bytes a product's record holds (lib/catalog.ts, MAX_PRODUCT_BYTES). */
export const ORDERS_LISTING_COMMANDS = 5;
/** Commands a pre-order's reading makes: its entry, and whether and when it ships. */
export const ORDERS_PREORDER_COMMANDS = 3;
/** Commands the purchases brought over or given make besides their entries: how many there are, the record read, and its first reading noted (a script and its count). */
export const ORDERS_IMPORTED_COMMANDS = 4;
/**
 * One entry of what was brought over or given, read with the address's whole
 * record, counted in commands: a product id and its { at, job, items, option },
 * items twenty ids at the most (lib/imported-purchases.ts, parse), under 2 KB,
 * as two commands of a kilobyte.
 */
export const ORDERS_IMPORTED_ENTRY_COMMANDS = 2;
/** Commands one call's room makes at the most (lib/call-rooms.ts, roomsFor): four reads, and a video room not made yet made and read back. */
export const ORDERS_ROOM_COMMANDS = 6;
/** Commands one private podcast feed makes at the most (lib/podcast-access.ts, feedToken), with the room its write is counted in. */
export const ORDERS_FEED_COMMANDS = 8;
/** Commands one license key makes at the most (lib/licence-keys.ts, keyForSale): read, or given with five tries at a unique one, with its writes. */
export const ORDERS_KEY_COMMANDS = 24;
/**
 * How long an opening waits on what it reads before it says the purchases could
 * not be read, inside ORDERS_OPEN_SECONDS so the page answers before it is cut.
 */
export const ORDERS_READ_MS = 25_000;
/**
 * What one download from the list of purchases takes to find its purchase
 * (lib/buyer-orders.ts, findPurchase; C3-78, MR, 4 November 2026), besides the
 * download's own request: DOWNLOAD_LOOKUP_UNITS of the store's buyer requests,
 * taken before the link's grant is read. They pay for the grant, the purchase
 * read by its own reference (one checkout, or a payment taken in one click
 * with the checkout it followed, from the creator's Stripe account; or the
 * one entry brought over), waited on DOWNLOAD_LOOKUP_MS at the most, and its
 * DOWNLOAD_LOOKUP_COMMANDS. The listings it reads, and each id of a record
 * brought over, are taken through an OrdersMeter before they are read, as on
 * the page. Never the whole list: a bundle's twenty files cost twenty lookups,
 * not twenty readings of every purchase. tests/plan-cost-registry.ts prices it
 * (DOWNLOAD_LOOKUP_READ) and tests/plan-cost-registry.test.ts holds the units
 * above it.
 */
export const DOWNLOAD_LOOKUP_UNITS = 2;
/** The longest a download waits on finding its purchase; past it the buyer is told the purchase could not be checked. */
export const DOWNLOAD_LOOKUP_MS = 10_000;
/** Commands a download's lookup makes besides its metered reads: the grant; for one brought over, how many ids there are, the ids and the one entry. */
export const DOWNLOAD_LOOKUP_COMMANDS = 4;
/**
 * Moves an opening of a store that sells calls takes before its bookings are
 * read: lib/calls.ts (paidCalls) reads the move of every booking on its pages,
 * at most five pages of a hundred checkouts, before their number is known
 * outside it (tests/orders-open.test.ts holds it to that file). What they do
 * not use pays the same opening's next reads.
 */
export const ORDERS_CALL_MOVES = 5 * 100;
