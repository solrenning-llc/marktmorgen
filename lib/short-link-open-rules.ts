/**
 * The figures that bound what opening a short link can cost
 * (app/l/[code]/route.ts, lib/short-link-open.ts). Plain values, so the
 * tests read them without the database.
 *
 * A link that opens is paid by its store, as one of its public requests
 * (SHORT_LINK_OPEN_UNITS, lib/traffic.ts). What no store pays for is the
 * company's (MR item 2): a code nobody has, a store gone, a request that
 * could not be counted or a connection over its share are counted in one
 * hour's count every server instance shares, and at most
 * SHORT_LINK_UNPAID_PER_HOUR of those read the database in an hour. A store
 * over its own requests is not in it: it is refused at most
 * SHORT_LINK_REST_REFUNDS_PER_MINUTE times a minute on each instance off the
 * hour (the rest are counted in it), and marked resting for
 * SHORT_LINK_TIRED_MS so its other links are refused without its record
 * read. Those, and each instance's own counts, are per instance; how many
 * instances run is not known, never zero (SHORT_LINK_UNPAID_COMPANY_COST,
 * tests/plan-cost-registry.ts).
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
/** How long an instance answers a link whose store could not take one more request without reading it again, and how long the store's resting mark (shortLinkRestKey) is kept. */
export const SHORT_LINK_TIRED_MS = 60_000;
/** Refusals for a store over its own requests one instance takes off the hour in a minute; past it they stay counted in the hour. */
export const SHORT_LINK_REST_REFUNDS_PER_MINUTE = 1;
/** How long an instance that found the hour used waits before counting again, instead of the rest of the hour. */
export const SHORT_LINK_USED_UP_PAUSE_MS = 60_000;
/** How long an instance keeps answering a link its store paid for a moment ago while the hour is used (the store pays each open), and how many it keeps. */
export const SHORT_LINK_KNOWN_MS = 60_000;
export const SHORT_LINK_KNOWN_KEPT = 5_000;
/** How long an instance refuses one connection a link, at no cost, after that connection was found over its share of the day. */
export const SHORT_LINK_CONNECTION_MS = 60_000;
/** Links an instance remembers that way at the most; past it the oldest are forgotten. */
export const SHORT_LINK_TIRED_KEPT = 5_000;

export const HOUR_MS = 3_600_000;
export const hourOf = (ms: number) => Math.floor(ms / HOUR_MS);
/** The key an hour's unpaid opens are counted in. */
export const shortLinkUnpaidKey = (now: number) => `nl:slink:open:${hourOf(now)}`;
/** A store's resting mark: written only when the store itself could not take one more request, kept SHORT_LINK_TIRED_MS. */
export const shortLinkRestKey = (sid: string) => `nl:slink:rest:${sid}`;
