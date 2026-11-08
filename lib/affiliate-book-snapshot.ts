/**
 * An affiliate program's book, worked out once for every affiliate and kept
 * (4 November 2026). Each affiliate's own page used to work out the whole
 * program's book on every load (every hash of it, up to 23 pages of the
 * creator's Stripe account): fifty affiliates looking once a day spent a
 * Store plan's window of requests in under two weeks, and then the store's
 * buyers met the resting page. Now the load that finds the book out of date
 * works it out for everybody, paid once (lib/affiliate-page-admission.ts),
 * and keeps each approved affiliate's own part under its own field, and the
 * part of anybody no longer approved who still has something in it (a
 * balance, a commission, a payment made); every other load reads only its
 * own part. The page says when the figures are from.
 *
 *   nl:aff:<statsId>:book        hash  affiliate id -> {"at":…, "book":…};
 *                                      "_at" when it was worked out, "_kept" "1"
 *                                      when the parts are in it, "_short" "1"
 *                                      when it was incomplete and is worked out
 *                                      again sooner, "_by" the refresh that wrote it
 *   nl:aff:<statsId>:book:new:<token>  the same, while one refresh writes it, then
 *                                      renamed into its place: named by that
 *                                      refresh's lock token, so two never share one
 *   nl:aff:<statsId>:book:draft  the token of the draft being written, so the
 *                                next refresh deletes one a stopped refresh left
 *   nl:aff:<statsId>:book:lock   a random token: one refresh at a time
 *   nl:aff:<statsId>:book:ver    raised each time a person is deleted; a
 *                                refresh that read before it keeps nothing.
 *                                When its keep ran out it starts again from
 *                                the deletion's instant in ms, never from
 *                                nothing, so it never repeats a value a
 *                                refresh read before (an INCR from nothing
 *                                did: 1, then 2, as eight days before)
 *   nl:aff:<statsId>:book:tries  paid refreshes in a row that kept no complete
 *                                book: raised before each one reads, set back
 *                                by a complete one
 *   nl:aff:<statsId>:book:tried  when the last paid refresh began, until it
 *                                writes: one that stopped before writing
 *                                (its function ended) counts as an incomplete
 *                                book, so the next waits as after one
 *
 * Every write of a refresh lands only while its lock is still its own and no
 * person was deleted since it began (one script each, checked and written in
 * one step); one that lost its lock or saw a deletion throws its draft away.
 * A Redis that cannot run the scripts writes nothing: the refresh keeps
 * nothing, and a deletion fails to be tried again.
 *
 * A refresh stops reading Stripe BOOK_READ_SECONDS after it began and keeps
 * what it read as an incomplete book, worked out again sooner, so it always
 * ends inside the page's maxDuration; and it is counted before it reads, so
 * paid refreshes are never more than once a day and BOOK_SHORT_TRIES more
 * (and one for an affiliate approved since), whatever stops them.
 *
 * Only what the page shows is kept: a lead's address masked as the page
 * masks it (first letter and domain), and none of the affiliate's own
 * address, PayPal address or note. Deleting a person (lib/affiliate-leads.ts,
 * forgetLeadPerson) deletes the whole kept book, worked out again at the
 * next load.
 *
 * A book larger than BOOK_SNAPSHOT_MAX_BYTES, or one that could not be
 * written, is not kept, but when it was worked out still is ("_kept" "0"),
 * so the refresh paid outside a connection's share stays once a day; until
 * then each load works out its own, paid from its own connection's share.
 */
import { type Book, readBook } from "@/lib/affiliates";
import { maskEmail } from "@/lib/affiliate-lead-rules";
import { isRedisConfigured, redisPipeline } from "@/lib/redis";
import { type Held, LockBusyError, releaseLock, takeLock } from "@/lib/redis-lock";
import type { Store } from "@/lib/store";

/** How long a complete kept book is shown before a load works it out again: a day (owner's decision through the coordinator, 4 November 2026; six hours spent too much of a Store window). */
export const BOOK_FRESH_SECONDS = 24 * 60 * 60;
/** How soon one that was incomplete (Stripe not all read: refundsChecked or invoicesChecked false) is worked out again. */
export const BOOK_SHORT_SECONDS = 15 * 60;
/** How many paid refreshes in a row without a complete book are worked out again that soon; past them, once a day like any other, until a complete one is written. */
export const BOOK_SHORT_TRIES = 3;
/** How long the count of paid refreshes without a complete book is kept: well past a day, so it is not forgotten between daily refreshes. */
export const BOOK_TRIES_KEEP_SECONDS = 30 * 24 * 60 * 60;
/**
 * How long it is kept: a week past being out of date, so a load that waits
 * on another's refresh reads the last one, and so an affiliate no longer
 * approved but still owed something is known to be (their part is in it).
 */
export const BOOK_KEEP_SECONDS = BOOK_FRESH_SECONDS + 7 * 24 * 60 * 60;
/** An approved affiliate missing from a fresh book (approved since) waits at least this long after it was worked out. */
export const BOOK_NEW_AFFILIATE_SECONDS = 15 * 60;
/** The affiliate page's maxDuration (app/[handle]/affiliates/page.tsx; a test holds the two equal). */
export const AFFILIATE_PAGE_MAX_SECONDS = 300;
/**
 * How long after it began a refresh stops asking Stripe (each call given at
 * most what is left): what it read is kept as an incomplete book, so the
 * refresh writes well inside the page's maxDuration rather than being
 * stopped with nothing written. Its worst read had been 23 pages at 20 s.
 */
export const BOOK_READ_SECONDS = 240;
/**
 * How long one refresh holds the others off: past the page's maxDuration,
 * with two minutes more, so a function stopped at its limit has surely
 * stopped before another refresh may start. Its writes are fenced by the
 * lock anyway.
 */
export const BOOK_LOCK_SECONDS = AFFILIATE_PAGE_MAX_SECONDS + 120;
/** The most a kept book may take, all its parts together, in bytes as Redis counts them (UTF-8). */
export const BOOK_SNAPSHOT_MAX_BYTES = 8_000_000;
/** Bytes and fields written per round, so no one request is large. */
const WRITE_BYTES = 512_000;
const WRITE_FIELDS = 500;
const AT = "_at";
const KEPT = "_kept";
const SHORT = "_short";
const BY = "_by";

const snapshotKey = (statsId: string) => `nl:aff:${statsId}:book`;
const draftKey = (statsId: string, token: string) => `nl:aff:${statsId}:book:new:${token}`;
const pointerKey = (statsId: string) => `nl:aff:${statsId}:book:draft`;
const lockKey = (statsId: string) => `nl:aff:${statsId}:book:lock`;
const versionKey = (statsId: string) => `nl:aff:${statsId}:book:ver`;
const triesKey = (statsId: string) => `nl:aff:${statsId}:book:tries`;
const triedKey = (statsId: string) => `nl:aff:${statsId}:book:tried`;

/** Bytes as Redis counts them: a masked "•" or a title in another script is more than one. */
const utf8 = (text: string) => Buffer.byteLength(text, "utf8");

/** One affiliate's part of the whole program's book: their row, their lines and their payouts. */
export function bookSlice(book: Book, id: string): Book {
  const rows = book.rows.filter((row) => row.affiliate.id === id);
  const lines = book.lines.filter((line) => line.aff === id);
  const payouts = book.payouts.filter((payout) => payout.aff === id);
  const elsewhere = lines.filter((l) => l.currency !== book.currency).length + payouts.filter((p) => p.currency !== book.currency).length;
  return { rows, lines, payouts, currency: book.currency, elsewhere, refundsChecked: book.refundsChecked, invoicesChecked: book.invoicesChecked };
}

/**
 * What of a part is kept: only what the affiliate's page shows. A lead's
 * address masked as the page masks it; the affiliate's own address, PayPal
 * address and note left out (the page reads those from their record).
 */
export function keptSlice(slice: Book): Book {
  return {
    ...slice,
    rows: slice.rows.map((row) => ({ ...row, affiliate: { ...row.affiliate, email: "", paypal: "", note: "" } })),
    lines: slice.lines.map((line) => (line.lead ? { ...line, lead: { ...line.lead, email: line.lead.email ? maskEmail(line.lead.email) : "" } } : line)),
  };
}

/** Whether somebody no longer approved still has something to see: a balance, a commission or a payment. */
export function hasSomething(slice: Book): boolean {
  const row = slice.rows[0];
  return Boolean(row && (row.owed !== 0 || row.earned !== 0 || row.paid !== 0)) || slice.lines.length > 0 || slice.payouts.length > 0;
}

export type SnapshotState = {
  /** When the kept book was worked out, in seconds; 0 when none is kept. */
  at: number;
  /** Whether its parts are kept, or only when it was worked out (too large, or not written). */
  kept: boolean;
  /** How long it stays in date: a day, or BOOK_SHORT_SECONDS for an incomplete one. */
  freshFor: number;
  /** The length of this affiliate's part of it; 0 when it holds none. */
  sliceBytes: number;
  /** When a paid refresh began that has written nothing yet (it is running, or it stopped), in seconds; 0 when none. */
  triedAt: number;
  /** Paid refreshes in a row that kept no complete book. */
  tries: number;
};

/** When the kept book is from, whether its parts are kept, how long this affiliate's part is, and any paid refresh that wrote nothing: four commands. Null when they cannot be read. */
export async function snapshotState(store: Store, id: string): Promise<SnapshotState | null> {
  if (!store.statsId || !isRedisConfigured()) return null;
  try {
    const [meta, length, tried, tries] = await redisPipeline([
      ["HMGET", snapshotKey(store.statsId), AT, KEPT, SHORT],
      ["HSTRLEN", snapshotKey(store.statsId), id],
      ["GET", triedKey(store.statsId)],
      ["GET", triesKey(store.statsId)],
    ]);
    const [at, kept, short] = Array.isArray(meta) ? meta : [];
    const counts = [Number(at ?? 0), Number(length ?? 0), Number(tried ?? 0), Number(tries ?? 0)];
    if (!counts.every((n) => Number.isSafeInteger(n) && n >= 0)) return null;
    const [when, bytes, triedAt, count] = counts;
    return { at: when, kept: kept === "1", freshFor: short === "1" ? BOOK_SHORT_SECONDS : BOOK_FRESH_SECONDS, sliceBytes: bytes, triedAt, tries: count };
  } catch {
    return null;
  }
}

/**
 * Whether a load should work the book out again: it is out of date, or this
 * affiliate is not in it and it is not brand new. Never while a paid refresh
 * that wrote nothing is recent: it counts as an incomplete book, waited on
 * BOOK_SHORT_SECONDS while the tries allow, a day past them.
 */
export function needsRefresh(state: SnapshotState, nowSeconds: number): boolean {
  if (state.triedAt) {
    const since = nowSeconds - state.triedAt;
    if (since >= 0 && since < (state.tries <= BOOK_SHORT_TRIES ? BOOK_SHORT_SECONDS : BOOK_FRESH_SECONDS)) return false;
  }
  const age = nowSeconds - state.at;
  if (!state.at || age >= state.freshFor || age < 0) return true;
  return state.kept && state.sliceBytes === 0 && age >= BOOK_NEW_AFFILIATE_SECONDS;
}

/** One refresh at a time, under a random token: the lock for the load that may work it out, or null. */
export async function claimRefresh(store: Store): Promise<Held | null> {
  if (!store.statsId) return null;
  try {
    return await takeLock(lockKey(store.statsId), BOOK_LOCK_SECONDS, 0);
  } catch (error) {
    if (!(error instanceof LockBusyError)) console.error("claiming an affiliate book's refresh failed", error);
    return null;
  }
}

/** Lets go of the refresh, only if it is still this load's. */
export async function releaseRefresh(held: Held): Promise<void> {
  await releaseLock(held);
}

/** This affiliate's part of the kept book, and when it was worked out; null when there is none. */
export async function readSlice(store: Store, id: string): Promise<{ book: Book; at: number } | null> {
  if (!store.statsId) return null;
  try {
    const [raw] = await redisPipeline([["HGET", snapshotKey(store.statsId), id]]);
    if (typeof raw !== "string") return null;
    const kept = JSON.parse(raw) as { at?: unknown; book?: Book };
    if (typeof kept.at !== "number" || !kept.book || !Array.isArray(kept.book.rows)) return null;
    return { book: kept.book, at: kept.at };
  } catch {
    return null;
  }
}

/**
 * The scripts a refresh writes with, each checked and written in one step on
 * the Redis side: they land only while the refresh's lock still holds its
 * token (KEYS[1], ARGV[1]) and, past the first, no person was deleted since
 * it began (KEYS[2] still ARGV[2]). There is no other way to write: a Redis
 * that cannot run them writes nothing (tests/security/affiliate-book.redis-run.ts
 * runs them on a real Redis).
 */
const HELD = 'if redis.call("GET", KEYS[1]) ~= ARGV[1] or (redis.call("GET", KEYS[2]) or "") ~= ARGV[2] then';
/** Counts a paid refresh before it reads: raises the tries (KEYS[2]) and marks when it began (KEYS[3]); the tries so far, or 0 when the lock is not its own. */
export const BOOK_ATTEMPT = `if redis.call("GET", KEYS[1]) ~= ARGV[1] then return 0 end
local tries = redis.call("INCR", KEYS[2])
redis.call("EXPIRE", KEYS[2], ARGV[3])
redis.call("SET", KEYS[3], ARGV[2], "EX", ARGV[4])
return tries`;
/** Takes back the count of a refresh whose charge was refused, if it is still its own (KEYS[3] still ARGV[2]). */
export const BOOK_UNDO = `if redis.call("GET", KEYS[1]) ~= ARGV[1] or redis.call("GET", KEYS[3]) ~= ARGV[2] then return 0 end
if redis.call("DECR", KEYS[2]) <= 0 then redis.call("DEL", KEYS[2]) end
redis.call("DEL", KEYS[3])
return 1`;
/** Starts a draft: deletes one a stopped refresh left (KEYS[4]) and this one's (KEYS[5]), and names this one's (KEYS[3]). */
export const BOOK_BEGIN = `${HELD} return 0 end
redis.call("DEL", KEYS[4], KEYS[5])
redis.call("SET", KEYS[3], ARGV[1], "EX", ARGV[3])
return 1`;
/** Writes a round of parts to the draft (KEYS[3]). */
export const BOOK_ROUND = `${HELD} return 0 end
redis.call("HSET", KEYS[3], unpack(ARGV, 4))
redis.call("EXPIRE", KEYS[3], ARGV[3])
return 1`;
/** A book written: the refresh is no longer pending (KEYS[7]), and a complete one (ARGV[4] "1") sets the tries (KEYS[6]) back. */
const WRITTEN = 'if ARGV[4] == "1" then redis.call("DEL", KEYS[6]) end\nredis.call("DEL", KEYS[7])';
/** Puts the draft (KEYS[3]) in the book's place (KEYS[4]); 1 too when this refresh's book is already there. */
export const BOOK_COMMIT = `${HELD} redis.call("DEL", KEYS[3]) return 0 end
if redis.call("HGET", KEYS[4], "${BY}") == ARGV[1] then return 1 end
redis.call("HSET", KEYS[3], unpack(ARGV, 5))
redis.call("EXPIRE", KEYS[3], ARGV[3])
redis.call("RENAME", KEYS[3], KEYS[4])
redis.call("DEL", KEYS[5])
${WRITTEN}
return 1`;
/** Keeps only when the book was worked out (KEYS[4]); 2, and nothing changed, when this refresh's whole book is already there. */
export const BOOK_MARK = `${HELD} redis.call("DEL", KEYS[3]) return 0 end
if redis.call("HGET", KEYS[4], "${BY}") == ARGV[1] then redis.call("DEL", KEYS[3]) return 2 end
redis.call("DEL", KEYS[3], KEYS[4], KEYS[5])
redis.call("HSET", KEYS[4], unpack(ARGV, 5))
redis.call("EXPIRE", KEYS[4], ARGV[3])
${WRITTEN}
return 1`;
/**
 * Deletes the book (KEYS[1]) and the draft named (KEYS[2]) and raises the version (KEYS[3]) as raiseVersion does,
 * from the deletion's instant in ms (ARGV[3]) when it is not there; 2 when the draft named changed meanwhile (KEYS[4]
 * no longer ARGV[1]).
 */
export const BOOK_FORGET = `if (redis.call("GET", KEYS[4]) or "") ~= ARGV[1] then return 2 end
redis.call("DEL", KEYS[1], KEYS[2])
redis.call("SET", KEYS[3], ARGV[3], "NX", "EX", ARGV[2])
redis.call("INCR", KEYS[3])
redis.call("EXPIRE", KEYS[3], ARGV[2])
return 1`;

/** Runs one of the scripts; throws, with nothing written, when the Redis cannot run it or gives no number. */
async function script(source: string, keys: string[], args: (string | number)[]): Promise<number> {
  const reply = await redisPipeline([["EVAL", source, keys.length, ...keys, ...args]]);
  const value = Array.isArray(reply) && reply.length === 1 ? Number(reply[0]) : Number.NaN;
  if (!Number.isSafeInteger(value)) throw new Error("an affiliate book script gave no answer");
  return value;
}

/** The version a refresh starts from: raised each time a person is deleted (forgetBookSnapshot). */
async function bookVersion(statsId: string): Promise<string> {
  const [version] = await redisPipeline([["GET", versionKey(statsId)]]);
  return version === null || version === undefined ? "" : String(version);
}

/**
 * Raises the version, kept BOOK_KEEP_SECONDS, with plain commands each done in
 * one step, so a Redis that cannot run the scripts raises it too: when it is
 * not there (never set, or its keep ran out) it starts from `now` (ms), then
 * one more. It only grows while it is kept; a value read before it ran out
 * began from an instant at least BOOK_KEEP_SECONDS earlier, so meeting it
 * again would take more deletions in one keep than there are milliseconds in
 * eight days: a refresh that read it keeps nothing.
 */
function raiseVersion(version: string, now: number): (string | number)[][] {
  return [["SET", version, now, "NX", "EX", BOOK_KEEP_SECONDS], ["INCR", version], ["EXPIRE", version, BOOK_KEEP_SECONDS]];
}

/**
 * Deletes the whole kept book and any draft being written, so the next load
 * works it out again, and raises the version first, so a refresh that began
 * before keeps nothing it read: when a person is deleted
 * (lib/affiliate-leads.ts, forgetLeadPerson, after their address came off
 * the lead). With no book and no draft there is nothing more to do: a
 * refresh writing later read the lead after the address came off, or is
 * thrown away by the version. Throws when it could not delete in one step,
 * so the deletion is tried again; the version is raised and what it can
 * deleted even then.
 */
export async function forgetBookSnapshot(statsId: string): Promise<void> {
  const book = snapshotKey(statsId);
  const version = versionKey(statsId);
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const now = Date.now();
    const [, , , seen, exists] = await redisPipeline([...raiseVersion(version, now), ["GET", pointerKey(statsId)], ["EXISTS", book]]);
    const token = typeof seen === "string" ? seen : "";
    if (!token && Number(exists) === 0) return;
    const draft = token ? draftKey(statsId, token) : book;
    let done: number;
    try {
      done = await script(BOOK_FORGET, [book, draft, version, pointerKey(statsId)], [token, BOOK_KEEP_SECONDS, now]);
    } catch (error) {
      await redisPipeline([["DEL", book, draft]]).catch(() => undefined);
      throw error;
    }
    if (done === 1) return;
  }
  throw new Error("an affiliate book's draft kept changing while it was deleted");
}

/**
 * Counts a paid refresh before it reads (BOOK_ATTEMPT), under its lock: how
 * many in a row now kept no complete book, this one included, or null when
 * it could not be counted (then it must not be paid for or read).
 */
export async function beginAttempt(store: Store, held: Held, at: number): Promise<number | null> {
  if (!store.statsId) return null;
  try {
    const tries = await script(BOOK_ATTEMPT, [held.key, triesKey(store.statsId), triedKey(store.statsId)], [held.token, String(at), BOOK_TRIES_KEEP_SECONDS, BOOK_FRESH_SECONDS]);
    return tries > 0 ? tries : null;
  } catch (error) {
    console.error("counting an affiliate book's refresh failed", error);
    return null;
  }
}

/** Takes the count back when the charge for it was refused; left as it is (one refresh more waited on) when it cannot. */
export async function undoAttempt(store: Store, held: Held, at: number): Promise<void> {
  if (!store.statsId) return;
  await script(BOOK_UNDO, [held.key, triesKey(store.statsId), triedKey(store.statsId)], [held.token, String(at)]).catch(() => 0);
}

/**
 * Keeps the whole program's book: each approved affiliate's part under their
 * own field (and that of anybody no longer approved who still has
 * something in it, hasSomething), only what the page shows of it
 * (keptSlice), written to this refresh's own draft that then takes the old
 * book's place, so no part of an older book stays behind. When it was worked
 * out is written in every case. `tries` is what beginAttempt counted. `kept`
 * false when the parts are not kept (past BOOK_SNAPSHOT_MAX_BYTES, or the
 * write failed); `short` when it is worked out again after
 * BOOK_SHORT_SECONDS rather than a day. Null, and nothing more kept, when
 * the lock is no longer this refresh's, a person was deleted since
 * `version` was read, or Redis could not run the scripts: what it read is
 * thrown away.
 */
export async function writeSnapshot(store: Store, book: Book, at: number, held: Held, version: string, tries: number): Promise<{ kept: boolean; short: boolean } | null> {
  if (!store.statsId) return null;
  try {
    return await write(store.statsId, book, at, held, version, tries);
  } catch (error) {
    console.error("keeping an affiliate book failed", error);
    return null;
  }
}

async function write(statsId: string, book: Book, at: number, held: Held, version: string, tries: number): Promise<{ kept: boolean; short: boolean } | null> {
  const key = snapshotKey(statsId);
  const draft = draftKey(statsId, held.token);
  const pointer = pointerKey(statsId);
  // The draft a stopped refresh may have left; not read, nothing is written.
  const [seen] = await redisPipeline([["GET", pointer]]);
  const complete = book.refundsChecked && book.invoicesChecked;
  const short = !complete && tries <= BOOK_SHORT_TRIES;
  const meta = [AT, String(at), SHORT, short ? "1" : "0", BY, held.token];
  const keys = [held.key, versionKey(statsId), draft, key, pointer, triesKey(statsId), triedKey(statsId)];
  const head = [held.token, version, BOOK_KEEP_SECONDS, complete ? "1" : "0"];
  const parts = book.rows
    .map((row) => ({ row, slice: bookSlice(book, row.affiliate.id) }))
    .filter(({ row, slice }) => row.affiliate.status === "approved" || hasSomething(slice))
    .map(({ row, slice }) => [row.affiliate.id, JSON.stringify({ at, book: keptSlice(slice) })] as const);
  const bytes = parts.reduce((sum, [id, value]) => sum + utf8(id) + utf8(value), 0);
  const thrownAway = async () => {
    await redisPipeline([["DEL", draft]]).catch(() => undefined);
    return null;
  };
  const markOnly = async () => {
    const marked = await script(BOOK_MARK, keys, [...head, ...meta, KEPT, "0"]);
    if (marked === 0) return thrownAway();
    return { kept: marked === 2, short };
  };
  if (bytes > BOOK_SNAPSHOT_MAX_BYTES) return markOnly();
  try {
    // A draft a stopped refresh left is deleted as this one begins, so there is never more than one.
    const left = typeof seen === "string" && seen ? draftKey(statsId, seen) : draft;
    if ((await script(BOOK_BEGIN, [held.key, versionKey(statsId), pointer, left, draft], [held.token, version, BOOK_LOCK_SECONDS * 2])) !== 1) return null;
    let round: string[] = [];
    let size = 0;
    const flush = async (): Promise<boolean> => {
      if (!round.length) return true;
      const pairs = round;
      round = [];
      size = 0;
      return (await script(BOOK_ROUND, [held.key, versionKey(statsId), draft], [held.token, version, BOOK_LOCK_SECONDS * 2, ...pairs])) === 1;
    };
    for (const [id, value] of parts) {
      const length = utf8(id) + utf8(value);
      if (round.length && (size + length > WRITE_BYTES || round.length >= WRITE_FIELDS * 2) && !(await flush())) return thrownAway();
      round.push(id, value);
      size += length;
    }
    if (!(await flush())) return thrownAway();
    if ((await script(BOOK_COMMIT, keys, [...head, ...meta, KEPT, "1"])) !== 1) return thrownAway();
    return { kept: true, short };
  } catch {
    return markOnly();
  }
}

/**
 * Works the whole program's book out and keeps it, under `held`
 * (claimRefresh), counted by beginAttempt (`tries`): Stripe is asked for no
 * longer than BOOK_READ_SECONDS, past which the book is incomplete. The book
 * itself whether or not it could be kept, whether it was, and whether it is
 * worked out again soon. Null when what it read was thrown away (the lock
 * ran out, a person was deleted while it read, or Redis could not write).
 */
export async function refreshBook(store: Store, at: number, held: Held, tries: number): Promise<{ book: Book; kept: boolean; short: boolean } | null> {
  if (!store.statsId) return null;
  const deadline = Date.now() + BOOK_READ_SECONDS * 1000;
  // Read before the book, so a deletion while it reads is seen when it writes.
  const version = await bookVersion(store.statsId);
  // readBook reads at most 200 open bookings across the whole program (lib/affiliates.ts, openBookings):
  // worked out for everybody at once, a program past that may read fewer of one affiliate's than their own book did.
  const book = await readBook(store, undefined, { deadline });
  const written = await writeSnapshot(store, book, at, held, version, tries);
  return written && { book, ...written };
}

/** The version a refresh starting now would read: for checks that write a book directly. */
export async function readBookVersion(store: Store): Promise<string> {
  return store.statsId ? bookVersion(store.statsId) : "";
}
