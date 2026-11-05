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
 * public-requests) and tests/plan-cost-registry.test.ts holds the units
 * above what they stand for, with a tenth to spare and no more.
 *
 * Measured on 4 November 2026 (C3-83, C3-90, C3-93, C3-97), in each of the 7
 * languages, with every field at its longest of the costliest character, the
 * store's handle (24) and every checkout's id (208) at the longest their
 * rules take, and every card shape (a course, a private podcast or a plain
 * product, each at a price option of its own link, keys from the creator's
 * list of 100 characters, given and taken back): the most is a private
 * podcast at a price option with its key taken back, in French, 6,076,927
 * bytes as sent, with the shell measured on a local production build (at
 * most 401,498, taken as 410,000), held under ORDERS_PAGE_BYTES (6,100,000).
 * An opening then costs $0.000964 at most before its metered reads; 17 units
 * at $0.0000633 are $0.001076, 11.6% to spare (16 would be 5.0%). 12 until the page was measured as it is sent: #2060 measured its
 * HTML alone, 2.5 MB, and so did not cover the payload or the shell.
 *
 * Taken from the public requests, never from the buyers' actions figure
 * (takeAllowance(store, "buyer"), lib/buyer-actions.ts): that figure is the
 * whole store's, with no share per person, so spending it on every opening
 * would let one buyer reloading the page use it up and stop every other
 * buyer's actions at the store.
 */
import { moveReads } from "@/lib/call-moves-read";

export const ORDERS_OPEN_UNITS = 17;
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
 * How long a request for the link waits on what it reads (lib/buyer-orders.ts,
 * requestOrdersLink): shorter than an opening's, so the link's grant (a write,
 * REDIS_TIMEOUT_MS at the most) and its email (RESEND_TIMEOUT_MS at the most)
 * still fit in the route's maxDuration, ORDERS_OPEN_SECONDS
 * (tests/orders-open.test.ts holds it).
 */
export const ORDERS_LINK_READ_MS = 12_000;
/**
 * What one download from the list of purchases takes to find its purchase
 * (lib/buyer-orders.ts, findPurchase; C3-78, MR, 4 November 2026), besides the
 * download's own request: DOWNLOAD_LOOKUP_UNITS of the store's buyer requests,
 * taken after the link's grant is read and before anything else is: the grant is
 * one read, paid by the request's own call (its per-link limit takes a
 * public request first), so a link that opens nothing takes nothing more. They pay for the purchase
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
 * One read of the moves of up to MOVES_PER_MGET bookings (lib/call-records.ts,
 * readMoves) counted in commands: the MGET, and its keys and moves through the
 * database (tests/plan-cost-registry.test.ts holds it above what it costs).
 */
export const ORDERS_MOVES_READ_COMMANDS = 2;
/** Commands the moves of this many bookings count as, read MOVES_PER_MGET at a command. */
export function ordersMovesCommands(bookings: number): number {
  return moveReads(bookings) * ORDERS_MOVES_READ_COMMANDS;
}
/**
 * Commands an opening of a store that sells calls takes before its bookings
 * are read: lib/calls.ts (paidCalls) reads the move of every booking on its
 * pages, at most five pages of a hundred checkouts, before their number is
 * known outside it (tests/orders-open.test.ts holds it to that file), a
 * hundred at a command. What they do not use pays the same opening's next reads.
 */
export const ORDERS_CALL_MOVES = ordersMovesCommands(5 * 100);

/**
 * The most calls one opening of the orders page, or one request for its link,
 * makes to the creator's Stripe account (C3-80, 4 November 2026). Without it a
 * buyer with a hundred purchases paid in installments made 1,216 calls in one
 * opening, enough to have Stripe refuse the creator's own checkouts for a
 * while. ORDERS_STRIPE_LISTS of them are the lists every opening may read,
 * bounded by the code itself; the rest pay for the refund checks of payment
 * plans, PLAN_REFUND_CALLS each, taken before each check is made. A purchase
 * whose check has no room left is not shown, and the page says some
 * purchases could not be checked: never that they were not bought.
 */
export const ORDERS_STRIPE_CALLS = 200;
/**
 * The lists every opening may read from Stripe, whatever the buyer has: the
 * buyer's checkouts under both spellings of the address (two), the payments
 * taken in one click for ten of their customers (ORDERS_ONE_CLICK_LISTS; each
 * further customer's list is a call taken from the rest, and one that does not
 * fit waits for a batch, said as not checked yet), and the store's bookings,
 * five pages at the most (lib/calls.ts, MAX_PAGES).
 */
export const ORDERS_STRIPE_LISTS = 2 + 10 + 5;
/**
 * Calls lib/refunds.ts makes at the most to read whether a purchase paid in
 * installments was given back: its first invoice, that invoice's payments
 * (ten at the most, its list's limit), each of those payments and, for each
 * one whose charge Stripe marks disputed, its disputes (givenBack)
 * (tests/orders-page-bounds.test.ts holds the ten to that file).
 */
export const PLAN_REFUND_CALLS = 1 + 1 + 10 + 10;

/**
 * What one opening of the orders page sends to the browser at the most, in
 * bytes (C3-80, 4 November 2026). A bundle's products are not drawn on the
 * page: each bundle is a button that reads them when the buyer asks
 * (app/api/store/orders/bundle/route.ts), so forty purchases of four
 * twenty-product bundles no longer draw 3,200 links. What the page still
 * draws is bounded by the store's own limits: forty purchases, each with its
 * own delivery and three ticked at checkout (each link at most 2,000
 * characters in its address, shown as text cut to LINK_SHOWN characters),
 * each with its bundle's button and its license key, forty booked calls and
 * what waits on the buyer. Counted as the App Router sends it
 * (tests/page-response.ts): the HTML, the RSC payload that carries the same
 * tree again (each address once more, & at six bytes there), and the
 * shell; every text of the character that costs the most in both, an address
 * longer than LINK_SHOWN named by its host and sent once, in its button's own
 * address (C3-90), and the shell as measured on a local production build
 * (tests/page-response.ts, SHELL_BYTES). Measured with the HTML alone it was
 * 2,650,000 until the review of 4 November 2026 found the payload missing. tests/orders-page-bounds.test.ts
 * holds a page drawn at those limits under it, and tests/plan-cost-registry.ts
 * prices it in ORDERS_OPEN_READ.
 */
export const ORDERS_PAGE_BYTES = 6_100_000;
/**
 * The longest address of a delivery the list of purchases shows as text. A
 * longer one is named by its host alone ("Kept on example.com"): its whole
 * address is only the button's own, one click away, and the button says what
 * it opens by the product's name (WCAG 2.4.9), so the address is sent once in
 * the HTML and once in the payload, never again as text (C3-90, 4 November
 * 2026; before, cut to 60 characters and then given whole to screen readers).
 */
export const LINK_SHOWN = 80;
/**
 * The longest host the list names a longer address by, a DNS label's own
 * limit (lib/purchase-cards.ts, keptLine): an address may carry a host of
 * almost 2,000 characters (lib/product-link.ts, readLink), and one longer than
 * this is not said at all, only kept in its button's address (review of
 * claude3/orders-page-bounds, 4 November 2026). A host written in another
 * script is said in it (domainToUnicode) when it fits.
 */
export const HOST_SHOWN = 63;

/**
 * What showing a bundle's products takes (app/api/store/orders/bundle/route.ts;
 * C3-80, 4 November 2026), besides the request's own call: ORDERS_BUNDLE_UNITS
 * of the store's buyer requests, taken after the link's grant is read and before anything else is: the grant is
 * one read, paid by the request's own call (its per-link limit takes a
 * public request first), so a link that opens nothing takes nothing more, in
 * place of a download's DOWNLOAD_LOOKUP_UNITS. They pay for the same lookup of
 * one purchase by its reference, and for the answer sent back, every product
 * of the bundle with its address and its key, ORDERS_BUNDLE_BYTES at the most.
 * The bundle's listings and keys are taken through the meter before they are
 * read. tests/plan-cost-registry.ts prices it (ORDERS_BUNDLE_READ) and
 * tests/plan-cost-registry.test.ts holds the units above it, with a tenth to
 * spare (2 until C3-83, when the page without JavaScript had to fit too):
 * $0.000135 at most, 3 units $0.000190, 40.4% to spare (measured 4 November
 * 2026; the page without JavaScript at most 1,014,727 bytes, its keys from
 * the creator's list taken back, in French).
 */
export const ORDERS_BUNDLE_UNITS = 3;
/**
 * The most bytes showing a bundle's products sends: twenty products, each with
 * its title, its address (2,000 characters), its download and course addresses
 * and its key with its label. The button's JSON answer is the smaller; the
 * page drawn without JavaScript (app/[handle]/orders/page.tsx, `bundle`) is
 * the larger, measured as it is sent (tests/page-response.ts), and is what
 * this holds (tests/orders-page-bounds.test.ts holds both under it).
 */
export const ORDERS_BUNDLE_BYTES = 1_020_000;
/** How often one link may show a bundle's products in an hour, as a download's link is limited. */
export const ORDERS_BUNDLE_PER_HOUR = 240;

/**
 * What checking a batch of older purchases takes (app/api/store/orders/older;
 * C3-80, 4 November 2026): an opening's purchases whose refund did not fit in
 * its ORDERS_STRIPE_CALLS wait under the list, said as not checked yet, and
 * the buyer checks them a batch at a time. ORDERS_OLDER_UNITS of the store's
 * buyer requests are taken after the link's grant is read and before anything else is: the grant is
 * one read, paid by the request's own call (its per-link limit takes a
 * public request first), so a link that opens nothing takes nothing more; they pay for the
 * request held at 2 GB as long as an opening (ORDERS_OPEN_SECONDS, which
 * bounds every call to Stripe it waits on), its ORDERS_OLDER_COMMANDS, and
 * its answer, ORDERS_OLDER_BYTES at the most. Every listing, key and feed it
 * reads past them goes through its meter. tests/plan-cost-registry.ts prices
 * it (ORDERS_OLDER_READ) and tests/plan-cost-registry.test.ts holds the units
 * above it, with a tenth to spare (8 until C3-83, when the page without
 * JavaScript had to fit too): $0.000534 at most, 10 units $0.000633, 18.5% to
 * spare, 9 only 6.6% (measured 4 November 2026; the page without JavaScript
 * at most 1,467,384 bytes: private podcasts at a price option, their keys
 * taken back, in French).
 */
export const ORDERS_OLDER_UNITS = 10;
/** Commands a batch makes besides its metered reads: the link's grant. */
export const ORDERS_OLDER_COMMANDS = 1;
/**
 * The most bytes a batch sends: ORDERS_OLDER_MOST purchases, each with its own
 * delivery and three ticked at checkout (an address of 2,000 characters),
 * their keys and bundles. The button's JSON answer is the smaller; the page
 * drawn without JavaScript (app/[handle]/orders/page.tsx, `older`), measured
 * as it is sent (tests/page-response.ts), is the larger and is what this
 * holds (tests/orders-page-bounds.test.ts holds both under it).
 */
export const ORDERS_OLDER_BYTES = 1_480_000;
/** How often one link may check a batch of older purchases in an hour. */
export const ORDERS_OLDER_PER_HOUR = 60;
/**
 * The most purchases one batch of older purchases shows (C3-80, 4 November
 * 2026): a checkout whose refund check is one call to Stripe (a charge marked
 * disputed) would otherwise let a batch show as many as the ceiling of calls
 * holds. A checkout and what was added to it in one click after paying count
 * one each; what does not fit waits for the next batch, said as not checked yet.
 */
export const ORDERS_OLDER_MOST = 8;
/** The lists of payments taken in one click every opening and every batch may read inside ORDERS_STRIPE_LISTS; each one past them is a call from the ceiling. */
export const ORDERS_ONE_CLICK_LISTS = 10;
/** The most customers whose payments taken in one click wait for a batch, named in the batch's address (lib/buyer-orders.ts, readOlderCursor). */
export const ORDERS_OLDER_PAID_MOST = 64;
