/**
 * The figures that bound what opening a short link can cost
 * (app/l/[code]/route.ts, lib/short-link-open.ts). Plain values, so the
 * tests read them without the database.
 *
 * A link that opens is paid by its store, as one of its public requests
 * (SHORT_LINK_OPEN_UNITS, lib/traffic.ts). What no store pays for is the
 * company's (MR item 2), in three parts:
 *
 *   - one hour's count every server instance shares, made before a code is
 *     looked up, in units (since 9 November 2026, Claude 2's first cost
 *     review): a code looked up takes one unit, given back once its store
 *     pays; a code nobody has keeps its one; an open whose store's record was
 *     read and that no store pays for (a store gone, a record or count that
 *     could not be read, a connection over its share) is counted again at
 *     SHORT_LINK_UNPAID_READ_UNITS. At most SHORT_LINK_UNPAID_PER_HOUR such
 *     reads, or SHORT_LINK_UNPAID_READ_UNITS times as many codes nobody has,
 *     read in an hour, and at most SHORT_LINK_KNOWN_UNPAID_PER_HOUR reads
 *     more, only for links paid on that instance a moment ago, while the hour
 *     is used. One address may make one instance look up at most
 *     SHORT_LINK_MISSES_PER_ADDRESS codes nobody has in
 *     SHORT_LINK_MISS_WINDOW_MS, so a few addresses cannot fill the hour;
 *   - a second hour's count every instance shares, the resting hour, for
 *     stores over their own requests only: at most
 *     SHORT_LINK_REST_UNPAID_PER_HOUR opens an hour, each the first open of a
 *     link whose store is found resting (moved out of the shared hour once its
 *     store is known) or a store asked again whether it still rests (counted
 *     here before it is read). Past it a resting store's open is refused and
 *     never counted in the shared hour, so a store that cannot pay never uses
 *     the hour every other store's links need; what it reads past it is held
 *     per resting store (its resting mark, written for SHORT_LINK_TIRED_MAX_MS
 *     once the resting hour is used) and per instance (it remembers the
 *     store), their numbers unknown, never zero;
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

/**
 * Opens in an hour (UTC), in the count every instance shares, that read a found link's store and that no store pays
 * for; the count is kept in units (SHORT_LINK_UNPAID_READ_UNITS each), so a code nobody has, one unit, is one of
 * SHORT_LINK_UNPAID_PER_HOUR * SHORT_LINK_UNPAID_READ_UNITS lookups.
 */
export const SHORT_LINK_UNPAID_PER_HOUR = 60;
/**
 * Units an open that read its store's record and that no store pays for takes in the shared hour; a code looked up
 * and not found takes one. Held in tests/short-link-open-cap.test.ts: this many lookups cost at least one such read.
 */
export const SHORT_LINK_UNPAID_READ_UNITS = 3;
/** Codes nobody has that one address may make one instance look up in SHORT_LINK_MISS_WINDOW_MS (memory only, no cost). */
export const SHORT_LINK_MISSES_PER_ADDRESS = 10;
export const SHORT_LINK_MISS_WINDOW_MS = 3_600_000;
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
/** How long an instance first answers a link whose store could not take one more request without reading it again, how long the store's resting mark (shortLinkRestKey) says it rests, and how long one open holds the right to ask it again (shortLinkRestCheckKey). */
export const SHORT_LINK_TIRED_MS = 60_000;
/**
 * Opens in an hour (UTC), in a second count every instance shares, of stores over their own requests: the first open
 * of a link whose store is found resting, moved there out of the shared hour, and a store asked again whether it still
 * rests, counted there before it is read. Past it, a first one is refused and never counted in the shared hour (since
 * 9 November 2026, Claude 2's first cost review), its store's resting mark kept SHORT_LINK_TIRED_MAX_MS, and a store
 * due to be asked again stays resting in the instance's memory for a minute, nothing sent.
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
/** Opens past SHORT_LINK_UNPAID_PER_HOUR, in the same count (in SHORT_LINK_UNPAID_READ_UNITS each), that may still read for a link its store paid for on that instance a moment ago (SHORT_LINK_KNOWN_MS); one that ends unpaid stays counted, so they are a ceiling too. */
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
/**
 * A store's resting mark: written only when the store itself could not take one more request. It holds the moment
 * (milliseconds) until which the store rests, SHORT_LINK_TIRED_MS after it was found resting (SHORT_LINK_TIRED_MAX_MS
 * once the resting hour is used), and is kept SHORT_LINK_UNPAID_KEY_SECONDS, so that once that moment is past the store
 * is still known to have rested, and only the open that takes shortLinkRestCheckKey reads its record again (Claude 2's
 * focal return on #3330, 9 November 2026: a mark gone made every open in flight read it).
 */
export const shortLinkRestKey = (sid: string) => `nl:slink:rest:${sid}`;
/** The one open, site-wide, that asks a store whose resting moment is past whether it still rests: SET NX, kept SHORT_LINK_TIRED_MS. */
export const shortLinkRestCheckKey = (sid: string) => `nl:slink:rest:${sid}:check`;

/**
 * Reads of one store's record that the store does not pay for, at most, an hour (the owner's decision 14 on #3330,
 * 9 November 2026: the US$81.49 a month one resting store could cost was not approved). Two counts of the store's
 * own, every instance sharing them, both taken in the pipeline that reads the store's id, before its record can be
 * read, the first day and in a cold burst alike: the reads it did not pay for this hour (shortLinkStoreHourKey, kept
 * once the store itself refused one) and the opens of it in flight (shortLinkStoreFlightKey, each place lapsing by
 * itself SHORT_LINK_FLIGHT_MS after it was taken, so a give-back lost to a timeout never holds the store; Claude 2's
 * focal on #3330). Past their sum the open is refused with nothing of the record read, the store marked resting a
 * minute and kept so in the instance's memory, unless it is in the list of stores that pay and has had fewer than
 * this many unpaid reads this hour: a paying store with room is never refused by it (it pays each read).
 */
export const SHORT_LINK_STORE_READS_PER_HOUR = 20;
/**
 * How long an open's place among its store's opens in flight lasts at most: past it, it lapses by itself. Longer than
 * the heaviest open can take (every Redis wait at its timeout, held in tests/short-link-open-cap.test.ts), so a place
 * never lapses while its read can still happen; a give-back lost holds the store this long at most.
 */
export const SHORT_LINK_FLIGHT_MS = 120_000;
/** Commands an open sends to be counted in its store's own counts: ZREMRANGEBYSCORE, ZADD, ZCARD and EXPIRE of the opens in flight, and GET of the hour's unpaid reads, in the pipeline that reads the store's id. */
export const SHORT_LINK_STORE_COUNT_COMMANDS = 5;
/** Commands an open sends to give its place among the opens in flight back: one ZREM. */
export const SHORT_LINK_STORE_REFUND_COMMANDS = 1;
/**
 * Commands a paying store's open past its opens in flight sends more (Claude 2's focal re-reviews on #3330): one
 * SISMEMBER of the list of stores that pay, a place among the store's paid reads in flight (ZREMRANGEBYSCORE, ZADD,
 * ZCARD, EXPIRE) and that place given back (ZREM, with its other place).
 */
export const SHORT_LINK_PAID_BURST_COMMANDS = 6;
/**
 * A paying store's reads past its opens in flight that may be in flight at once, in a count of that store's own
 * (shortLinkPaidFlightKey), each place lapsing by itself SHORT_LINK_FLIGHT_MS later and given back once the store pays:
 * so a paying store with room opens SHORT_LINK_STORE_READS_PER_HOUR + this many at once, whatever other stores do
 * (Claude 2's focal re-review on #3330 @125a390e49), and one that has just run out of its own requests reads its record,
 * in the hour, at most these and its own SHORT_LINK_STORE_READS_PER_HOUR (its reads admitted only while its hour's
 * unpaid reads are fewer than that).
 */
export const SHORT_LINK_PAID_FLIGHT_PER_STORE = 40;
/**
 * A paying store's opens refused past its paid reads in flight (SHORT_LINK_PAID_FLIGHT_PER_STORE) that may be refused
 * one by one in an hour (Claude 2's focal on #3330 @39da7f44db, LEVE 2: each such refusal sent six pipelines and was
 * counted in no hour). Every one is counted, in a count of that store's own (shortLinkPaidRefusedKey), with the
 * give-back of its places; past this figure, or a count that cannot be read, the store pauses on its own
 * (paidPauseMark): SHORT_LINK_TIRED_MS, its mark written where none is and kept so in the instance's memory, never
 * doubled, never counted in the resting hour other stores share (Claude 2's focal on #3330 @f6b792b9c3, MEDIUM), so
 * the opens after it send nothing more than an open refused on its mark, still counted in the store's own count; the
 * minute past, it opens again. The figure bounds refusals one by one: within one burst at once, every open past the
 * paid flight on an instance takes this path before any mark exists (Claude 2's LEVE 2 on f6b792b9c3), as the resting
 * stores' paths do. A store with room opens SHORT_LINK_STORE_READS_PER_HOUR + SHORT_LINK_PAID_FLIGHT_PER_STORE at once
 * all the same.
 */
export const SHORT_LINK_PAID_REFUSALS_PER_HOUR = 20;
/** A paying store's opens refused past its paid reads in flight this hour (SHORT_LINK_PAID_REFUSALS_PER_HOUR), kept two hours. */
export const shortLinkPaidRefusedKey = (sid: string, now: number) => `nl:slink:rest:${sid}:paidout:${hourOf(now)}`;
/** A paying store's reads past its opens in flight, in flight: a sorted set scored by when each took its place, kept two times SHORT_LINK_FLIGHT_MS. */
export const shortLinkPaidFlightKey = (sid: string) => `nl:slink:rest:${sid}:paidflight`;
/** How long a store without a paid plan rests, without a gap, before its links are turned off (the owner's decision 14). */
export const SHORT_LINK_OFF_AFTER_MS = 30 * 86_400_000;
/**
 * The longest a store's record may go unread while it still counts as resting without a gap, and while its links stay
 * turned off: past it, one open reads it again (Claude 2's focal on #3330: the 30 days counted from a mark's age).
 */
export const SHORT_LINK_OFF_CONFIRM_MS = 86_400_000;
/** How long a resting mark of a store without a paid plan is kept past its last reading, and the longest gap between two readings that still counts as resting without a gap. Never renewed by a link answered off. */
export const SHORT_LINK_OFF_KEEP_SECONDS = 2 * 86_400;
/** The longest a paying store over its own requests is marked resting for: until its window ends, at most this. */
export const SHORT_LINK_PAID_REST_MAX_MS = 32 * 86_400_000;
/** How long the studio is told that the store's links were turned off, once it pays again. */
export const SHORT_LINK_BACK_NOTICE_SECONDS = 30 * 86_400;
/** How long an instance remembers the store of a link whose store it found resting or turned off (a link's store never changes). */
export const SHORT_LINK_RESTING_OWNER_MS = 24 * 3_600_000;
/** A store's reads of its record it did not pay for in the hour (SHORT_LINK_STORE_READS_PER_HOUR), kept two hours. */
export const shortLinkStoreHourKey = (sid: string, now: number) => `nl:slink:rest:${sid}:cap:${hourOf(now)}`;
/** A store's opens in flight, a sorted set scored by when each took its place, kept two minutes. */
export const shortLinkStoreFlightKey = (sid: string) => `nl:slink:rest:${sid}:flight`;
/** The studio's notice that the store's links were turned off: "<turned off at>:<back at>", in milliseconds. */
export const shortLinkBackKey = (sid: string) => `nl:slink:rest:${sid}:back`;
/**
 * What a resting mark holds: "<until>" (a store that pays, a store found past its own count, or a mark written before
 * 9 November 2026), "<until>:<since>:<read>" for a store without a paid plan: since when it has rested without a
 * gap, and when its record last said so; or "<until>:paid" (paidPauseMark), a paying store paused on its own past its
 * refusals of the hour (`paid`). Null for anything else, read as resting.
 */
export function readRestMark(value: unknown): { until: number; since: number | null; read: number | null; paid?: true } | null {
  const text = typeof value === "number" ? String(value) : value;
  if (typeof text !== "string") return null;
  const found = /^([0-9]{13,15})(?::([0-9]{13,15}):([0-9]{13,15})|(:paid))?$/.exec(text);
  if (!found) return null;
  const [until, since, read] = [found[1], found[2], found[3]].map((part) => (part === undefined ? null : Number(part)));
  if (until === null || !Number.isSafeInteger(until) || (since !== null && !Number.isSafeInteger(since)) || (read !== null && !Number.isSafeInteger(read))) return null;
  return found[4] ? { until, since: null, read: null, paid: true } : { until, since, read };
}

/**
 * A paying store's own pause, written on its resting mark (shortLinkRestKey, read in every open's first pipeline, so no
 * command is added) when it is refused past its paid reads in flight more than SHORT_LINK_PAID_REFUSALS_PER_HOUR times
 * in an hour, or that count cannot be read: SHORT_LINK_TIRED_MS, never doubled, counted in no shared hour, and never
 * remembered as resting (Claude 2's focal on #3330 @f6b792b9c3, MEDIUM). Written only where no mark is (NX).
 */
export const paidPauseMark = (until: number) => `${until}:paid`;

/**
 * Whether a store's links are turned off at `now`: its mark says it has rested without a paid plan, without a gap,
 * SHORT_LINK_OFF_AFTER_MS, and its record said so less than SHORT_LINK_OFF_CONFIRM_MS ago. "stale" when it would be,
 * but that reading is too old: one open must read the record again first.
 */
export function offState(mark: { since: number | null; read: number | null } | null, now: number): "off" | "stale" | null {
  if (!mark || mark.since === null || mark.read === null || mark.read - mark.since < SHORT_LINK_OFF_AFTER_MS) return null;
  return now - mark.read <= SHORT_LINK_OFF_CONFIRM_MS ? "off" : "stale";
}
