/**
 * The figures that bound what opening a short link can cost
 * (app/l/[code]/route.ts, lib/short-link-open.ts). Plain values, so the
 * company's fixed costs (lib/llc-fixed-costs.ts) and the tests read them
 * without the database.
 *
 * A link that opens is paid by its store, as one of its public requests
 * (SHORT_LINK_OPEN_UNITS, lib/traffic.ts). What no store pays for — a code
 * nobody has, a link whose store cannot take one more request — is the
 * company's (MR item 2), and at most SHORT_LINK_UNPAID_PER_HOUR of those
 * read the database in an hour, for the whole site.
 */

/** Opens in an hour (UTC), for the whole site, that no store pays for and that read the database. */
export const SHORT_LINK_UNPAID_PER_HOUR = 60;
/** How long an hour's count is kept: past its hour, so a late request still finds it. */
export const SHORT_LINK_UNPAID_KEY_SECONDS = 2 * 3600;
/** Commands an open sends to be counted before it reads: INCR and EXPIRE, in one pipeline. */
export const SHORT_LINK_COUNT_COMMANDS = 2;
/** Commands an open sends to read: the link (lib/short-links.ts, findLink), then the store's id and record (lib/store.ts, storeForId). */
export const SHORT_LINK_READ_COMMANDS = 3;
/** Commands a paid open sends to take itself off the hour's unpaid count: one DECR. */
export const SHORT_LINK_REFUND_COMMANDS = 1;
/** The store's public requests one open takes (lib/traffic.ts, takePublicRequest): two, since a whole store record read with a heavy request's wait costs more than one later page; held above its cost in tests/plan-cost-registry.test.ts. */
export const SHORT_LINK_OPEN_UNITS = 2;
/** Opens one address may make one server instance answer in SHORT_LINK_ADDRESS_WINDOW_MS (lib/local-limit.ts). */
export const SHORT_LINK_OPENS_PER_ADDRESS = 30;
export const SHORT_LINK_ADDRESS_WINDOW_MS = 10 * 60_000;
/** How long an instance waits before counting again after a count it could not read. */
export const SHORT_LINK_UNKNOWN_PAUSE_MS = 60_000;
/** How long an instance answers a link whose store could not take one more request without reading it again. */
export const SHORT_LINK_TIRED_MS = 60_000;
/** Links an instance remembers that way at the most; past it the oldest are forgotten. */
export const SHORT_LINK_TIRED_KEPT = 5_000;

export const HOUR_MS = 3_600_000;
export const hourOf = (ms: number) => Math.floor(ms / HOUR_MS);
/** The key an hour's unpaid opens are counted in. */
export const shortLinkUnpaidKey = (now: number) => `nl:slink:open:${hourOf(now)}`;
