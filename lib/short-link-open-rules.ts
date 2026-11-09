/**
 * The figures that bound what opening a short link can cost
 * (app/l/[code]/route.ts, lib/short-link-open.ts). Plain values, so the
 * tests read them without the database.
 *
 * A link that opens is paid by its store, as one of its public requests
 * (SHORT_LINK_OPEN_UNITS, lib/traffic.ts). What no store pays for is the
 * company's (MR item 2), in three parts:
 *
 *   - one hour's count every server instance shares, made before anything is
 *     read: at most SHORT_LINK_UNPAID_PER_HOUR opens no store pays for read
 *     the database in an hour (a code nobody has, a store gone, a request
 *     that could not be counted, a connection over its share, the first open
 *     of a store found resting once the resting hour is used), and at most
 *     SHORT_LINK_KNOWN_UNPAID_PER_HOUR more, only for links paid on that
 *     instance a moment ago, while the hour is used;
 *   - a second hour's count every instance shares, the resting hour, for
 *     stores over their own requests only: at most
 *     SHORT_LINK_REST_UNPAID_PER_HOUR opens an hour, each the first open of a
 *     link whose store is found resting (moved out of the shared hour once its
 *     store is known) or a store asked again whether it still rests (counted
 *     here before it is read). So a store over its own requests never uses the
 *     hour every other store's links need, until the resting hour is used;
 *   - on each instance, one count a minute while either hour is used or a
 *     count is unreadable. How many instances run is not known, never zero
 *     (SHORT_LINK_UNPAID_COMPANY_COST, tests/plan-cost-registry.ts).
 *
 * Every other refusal is answered from the instance's memory, with nothing
 * sent to the database: a store it knows is resting (all of its links, by
 * SHORT_LINK_OWNER_MS), a connection over its share of a store's day (until
 * the day or the store's window ends), a code it found ended
 * (SHORT_LINK_ENDED_MS).
 */

/** Opens in an hour (UTC), in the count every instance shares, that no store pays for and that read the database. */
export const SHORT_LINK_UNPAID_PER_HOUR = 60;
/** How long an hour's count is kept: past its hour, so a late request still finds it. */
export const SHORT_LINK_UNPAID_KEY_SECONDS = 2 * 3600;
/** Commands an open sends to be counted before it reads: INCR and EXPIRE, in one pipeline. */
export const SHORT_LINK_COUNT_COMMANDS = 2;
/** Commands an open sends to read: the link (lib/short-links.ts, findLink), then the store's id and record (lib/store.ts, storeForId). */
export const SHORT_LINK_READ_COMMANDS = 3;
/** Commands an open sends to take itself off the hour's unpaid count once its store is found: a DECR and an EXPIRE of the same key, in the pipeline that reads the store's id, so a count that lapsed in between is never left at -1 without an expiry. */
export const SHORT_LINK_REFUND_COMMANDS = 2;
/** Commands an open sends to learn whether its store is resting (shortLinkRestKey): one GET, in the same pipeline. */
export const SHORT_LINK_REST_COMMANDS = 1;
/** The store's public requests one open takes (lib/traffic.ts, takePublicRequest): two, since a whole store record read with a heavy request's wait costs more than one later page; held above its cost in tests/plan-cost-registry.test.ts. */
export const SHORT_LINK_OPEN_UNITS = 2;
/** Opens one address may make one server instance answer in SHORT_LINK_ADDRESS_WINDOW_MS (lib/local-limit.ts). */
export const SHORT_LINK_OPENS_PER_ADDRESS = 30;
export const SHORT_LINK_ADDRESS_WINDOW_MS = 10 * 60_000;
/** How long an instance waits before counting again after a count it could not read. */
export const SHORT_LINK_UNKNOWN_PAUSE_MS = 60_000;
/** How long an instance first answers a link whose store could not take one more request without reading it again, and how long the store's resting mark (shortLinkRestKey) is kept. */
export const SHORT_LINK_TIRED_MS = 60_000;
/**
 * Opens in an hour (UTC), in a second count every instance shares, of stores over their own requests: the first open
 * of a link whose store is found resting, moved there out of the shared hour, and a store asked again whether it still
 * rests, counted there before it is read. Past it, a first one stays counted in the shared hour, and a store due to be
 * asked again stays resting in the instance's memory for a minute, nothing sent.
 */
export const SHORT_LINK_REST_UNPAID_PER_HOUR = 120;
/** How long an instance that found the hour used waits before counting again, instead of the rest of the hour. */
export const SHORT_LINK_USED_UP_PAUSE_MS = 60_000;
/** How long an instance keeps answering a link its store paid for a moment ago while the hour is used (the store pays each open), and how many it keeps. */
export const SHORT_LINK_KNOWN_MS = 60_000;
export const SHORT_LINK_KNOWN_KEPT = 5_000;
/** How long an instance refuses one connection a link, at no cost, after that connection was found over its share of the day. */
export const SHORT_LINK_CONNECTION_MS = 60_000;
/** Links, stores and connections an instance remembers each way at the most; past it the oldest are forgotten. */
export const SHORT_LINK_TIRED_KEPT = 5_000;
/** Opens past SHORT_LINK_UNPAID_PER_HOUR, in the same count, that may still read for a link its store paid for on that instance a moment ago (SHORT_LINK_KNOWN_MS); one that ends unpaid stays counted, so they are a ceiling too. */
export const SHORT_LINK_KNOWN_UNPAID_PER_HOUR = 20;
/** How long an instance remembers which store a link it read belongs to: a link's store never changes. */
export const SHORT_LINK_OWNER_MS = 3_600_000;
/** How long an instance answers a code it found ended (no link, or its store gone) as ended without reading it again. */
export const SHORT_LINK_ENDED_MS = 3_600_000;
/** The longest an instance keeps a store resting from memory: asked again and still resting, it is kept twice as long as the time before, from SHORT_LINK_TIRED_MS up to this. */
export const SHORT_LINK_TIRED_MAX_MS = 10 * 60_000;

export const HOUR_MS = 3_600_000;
export const hourOf = (ms: number) => Math.floor(ms / HOUR_MS);
/** The key an hour's unpaid opens are counted in. */
export const shortLinkUnpaidKey = (now: number) => `nl:slink:open:${hourOf(now)}`;
/** The key an hour's opens of resting stores are counted in (SHORT_LINK_REST_UNPAID_PER_HOUR), apart from the shared hour. */
export const shortLinkRestHourKey = (now: number) => `nl:slink:tired:${hourOf(now)}`;
/** A store's resting mark: written only when the store itself could not take one more request, kept SHORT_LINK_TIRED_MS. */
export const shortLinkRestKey = (sid: string) => `nl:slink:rest:${sid}`;
