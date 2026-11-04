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
 *                                      again sooner, "_tries" how many times so
 *   nl:aff:<statsId>:book:new    the same, while it is written, then renamed
 *   nl:aff:<statsId>:book:lock   a random token, a minute or two: one refresh at a time
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
/** How many times running an incomplete book is worked out again that soon; past them, once a day like any other. */
export const BOOK_SHORT_TRIES = 3;
/**
 * How long it is kept: a week past being out of date, so a load that waits
 * on another's refresh reads the last one, and so an affiliate no longer
 * approved but still owed something is known to be (their part is in it).
 */
export const BOOK_KEEP_SECONDS = BOOK_FRESH_SECONDS + 7 * 24 * 60 * 60;
/** An approved affiliate missing from a fresh book (approved since) waits at least this long after it was worked out. */
export const BOOK_NEW_AFFILIATE_SECONDS = 15 * 60;
/** How long one refresh holds the others off. */
export const BOOK_LOCK_SECONDS = 120;
/** The most a kept book may take, all its parts together. */
export const BOOK_SNAPSHOT_MAX_BYTES = 8_000_000;
/** Parts written per round, so no one request is large. */
const WRITE_BYTES = 512_000;
const AT = "_at";
const KEPT = "_kept";
const SHORT = "_short";
const TRIES = "_tries";

const snapshotKey = (statsId: string) => `nl:aff:${statsId}:book`;
const draftKey = (statsId: string) => `nl:aff:${statsId}:book:new`;
const lockKey = (statsId: string) => `nl:aff:${statsId}:book:lock`;

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
};

/** When the kept book is from, whether its parts are kept, and how long this affiliate's part is: two commands. Null when they cannot be read. */
export async function snapshotState(store: Store, id: string): Promise<SnapshotState | null> {
  if (!store.statsId || !isRedisConfigured()) return null;
  try {
    const [meta, length] = await redisPipeline([
      ["HMGET", snapshotKey(store.statsId), AT, KEPT, SHORT],
      ["HSTRLEN", snapshotKey(store.statsId), id],
    ]);
    const [at, kept, short] = Array.isArray(meta) ? meta : [];
    const when = Number(at ?? 0);
    const bytes = Number(length ?? 0);
    if (!Number.isSafeInteger(when) || when < 0 || !Number.isSafeInteger(bytes) || bytes < 0) return null;
    return { at: when, kept: kept === "1", freshFor: short === "1" ? BOOK_SHORT_SECONDS : BOOK_FRESH_SECONDS, sliceBytes: bytes };
  } catch {
    return null;
  }
}

/** Whether a load should work the book out again: it is out of date, or this affiliate is not in it and it is not brand new. */
export function needsRefresh(state: SnapshotState, nowSeconds: number): boolean {
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

/** Deletes the whole kept book, so the next load works it out again: when a person is deleted (lib/affiliate-leads.ts, forgetLeadPerson). */
export async function forgetBookSnapshot(statsId: string): Promise<void> {
  await redisPipeline([["DEL", snapshotKey(statsId), draftKey(statsId)]]);
}

/**
 * Keeps the whole program's book: each approved affiliate's part under their
 * own field (and that of anybody no longer approved who still has
 * something in it, hasSomething), only what the page shows of it
 * (keptSlice), written to a draft that then takes the old one's place, so no
 * part of an older book stays behind. When it was worked out is written in
 * every case. `kept` false when the parts are not kept (past
 * BOOK_SNAPSHOT_MAX_BYTES, or the write failed); `short` when it is worked
 * out again after BOOK_SHORT_SECONDS rather than a day.
 */
export async function writeSnapshot(store: Store, book: Book, at: number): Promise<{ kept: boolean; short: boolean }> {
  if (!store.statsId) return { kept: false, short: false };
  const key = snapshotKey(store.statsId);
  const draft = draftKey(store.statsId);
  const [previous] = await redisPipeline([["HMGET", key, SHORT, TRIES]]).catch(() => [null]);
  const tries = Array.isArray(previous) && previous[0] === "1" ? Number(previous[1]) || 0 : 0;
  const complete = book.refundsChecked && book.invoicesChecked;
  const short = !complete && tries < BOOK_SHORT_TRIES;
  const meta = [AT, String(at), SHORT, short ? "1" : "0", TRIES, String(short ? tries + 1 : 0)];
  const parts = book.rows
    .map((row) => ({ row, slice: bookSlice(book, row.affiliate.id) }))
    .filter(({ row, slice }) => row.affiliate.status === "approved" || hasSomething(slice))
    .map(({ row, slice }) => [row.affiliate.id, JSON.stringify({ at, book: keptSlice(slice) })] as const);
  const bytes = parts.reduce((sum, [, value]) => sum + value.length, 0);
  const markOnly = async () => {
    await redisPipeline([["DEL", key, draft], ["HSET", key, ...meta, KEPT, "0"], ["EXPIRE", key, BOOK_KEEP_SECONDS]]).catch(() => undefined);
    return { kept: false, short };
  };
  if (bytes > BOOK_SNAPSHOT_MAX_BYTES) return markOnly();
  try {
    await redisPipeline([["DEL", draft]]);
    let round: string[] = [];
    let size = 0;
    const flush = async () => {
      if (!round.length) return;
      await redisPipeline([["HSET", draft, ...round], ["EXPIRE", draft, BOOK_LOCK_SECONDS * 2]]);
      round = [];
      size = 0;
    };
    for (const [id, value] of parts) {
      if (size + value.length > WRITE_BYTES) await flush();
      round.push(id, value);
      size += value.length;
    }
    await flush();
    await redisPipeline([["HSET", draft, ...meta, KEPT, "1"], ["EXPIRE", draft, BOOK_KEEP_SECONDS], ["RENAME", draft, key]]);
    return { kept: true, short };
  } catch {
    return markOnly();
  }
}

/** Works the whole program's book out and keeps it; the book itself whether or not it could be kept, and whether it is worked out again soon. */
export async function refreshBook(store: Store, at: number): Promise<{ book: Book; short: boolean }> {
  // readBook reads at most 200 open bookings across the whole program (lib/affiliates.ts, openBookings):
  // worked out for everybody at once, a program past that may read fewer of one affiliate's than their own book did.
  const book = await readBook(store);
  const { short } = await writeSnapshot(store, book, at);
  return { book, short };
}
