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
/** Commands the purchases brought over or given make: the address's record, and its first reading noted. */
export const ORDERS_IMPORTED_COMMANDS = 2;
/** Commands one call's room makes (lib/call-rooms.ts, roomsFor): four reads. */
export const ORDERS_ROOM_COMMANDS = 4;
/** Commands one private podcast feed makes at the most (lib/podcast-access.ts, feedToken), with the room its write is counted in. */
export const ORDERS_FEED_COMMANDS = 8;
/** Commands one license key makes at the most (lib/licence-keys.ts, keyForSale): read, or given with five tries at a unique one, with its writes. */
export const ORDERS_KEY_COMMANDS = 24;
/**
 * Reads of the moves an opening of a store that sells calls makes before its
 * buyer's bookings are known: lib/calls.ts (paidCalls) reads the move of every
 * booking on its pages, at most five pages of a hundred checkouts
 * (tests/orders-open.test.ts holds it to that file).
 */
export const ORDERS_CALL_MOVES = 5 * 100;
