/**
 * An affiliate program's book, worked out once for every affiliate and kept
 * a few hours (4 November 2026). Each affiliate's own page used to work out
 * the whole program's book on every load (every hash of it, up to 23 pages
 * of the creator's Stripe account): fifty affiliates looking once a day
 * spent a Store plan's window of requests in under two weeks, and then the
 * store's buyers met the resting page. Now the load that finds the book out
 * of date works it out for everybody, paid once (lib/affiliate-page-admission.ts),
 * and keeps each approved affiliate's own part under its own field; every
 * other load reads only its own part. The page says when the figures are from.
 *
 *   nl:aff:<statsId>:book        hash  affiliate id -> {"at":…, "book":…}, and "_at" -> when it was worked out
 *   nl:aff:<statsId>:book:lock   string, a minute or two: one refresh at a time
 *
 * The whole is kept at most BOOK_SNAPSHOT_MAX_BYTES; a book larger than
 * that is not kept, and every load then works out its own, paid in full.
 */
import { type Book, readBook } from "@/lib/affiliates";
import { isRedisConfigured, redisPipeline } from "@/lib/redis";
import type { Store } from "@/lib/store";

/** How long a kept book is shown before a load works it out again. */
export const BOOK_FRESH_SECONDS = 6 * 60 * 60;
/** How long it is kept: a quarter of an hour more, so a load that waits on another's refresh reads the last one. */
export const BOOK_KEEP_SECONDS = BOOK_FRESH_SECONDS + 15 * 60;
/** An approved affiliate missing from a fresh book (approved since) waits at least this long after it was worked out. */
export const BOOK_NEW_AFFILIATE_SECONDS = 15 * 60;
/** How long one refresh holds the others off. */
export const BOOK_LOCK_SECONDS = 120;
/** The most a kept book may take, all its parts together. */
export const BOOK_SNAPSHOT_MAX_BYTES = 8_000_000;
/** Parts written per round, so no one request is large. */
const WRITE_BYTES = 512_000;
const AT = "_at";

const snapshotKey = (statsId: string) => `nl:aff:${statsId}:book`;
const lockKey = (statsId: string) => `nl:aff:${statsId}:book:lock`;

/** One affiliate's part of the whole program's book: their row, their lines and their payouts. */
export function bookSlice(book: Book, id: string): Book {
  const rows = book.rows.filter((row) => row.affiliate.id === id);
  const lines = book.lines.filter((line) => line.aff === id);
  const payouts = book.payouts.filter((payout) => payout.aff === id);
  const elsewhere = lines.filter((l) => l.currency !== book.currency).length + payouts.filter((p) => p.currency !== book.currency).length;
  return { rows, lines, payouts, currency: book.currency, elsewhere, refundsChecked: book.refundsChecked, invoicesChecked: book.invoicesChecked };
}

export type SnapshotState = {
  /** When the kept book was worked out, in seconds; 0 when none is kept. */
  at: number;
  /** The length of this affiliate's part of it; 0 when it holds none. */
  sliceBytes: number;
};

/** When the kept book is from and how long this affiliate's part of it is: two commands. Null when they cannot be read. */
export async function snapshotState(store: Store, id: string): Promise<SnapshotState | null> {
  if (!store.statsId || !isRedisConfigured()) return null;
  try {
    const [at, length] = await redisPipeline([
      ["HGET", snapshotKey(store.statsId), AT],
      ["HSTRLEN", snapshotKey(store.statsId), id],
    ]);
    const when = Number(at ?? 0);
    const bytes = Number(length ?? 0);
    if (!Number.isSafeInteger(when) || when < 0 || !Number.isSafeInteger(bytes) || bytes < 0) return null;
    return { at: when, sliceBytes: bytes };
  } catch {
    return null;
  }
}

/** Whether a load should work the book out again: it is out of date, or this affiliate is not in it and it is not brand new. */
export function needsRefresh(state: SnapshotState, nowSeconds: number): boolean {
  const age = nowSeconds - state.at;
  if (!state.at || age >= BOOK_FRESH_SECONDS || age < 0) return true;
  return state.sliceBytes === 0 && age >= BOOK_NEW_AFFILIATE_SECONDS;
}

/** One refresh at a time: true for the load that may work it out. */
export async function claimRefresh(store: Store): Promise<boolean> {
  if (!store.statsId) return false;
  try {
    const [got] = await redisPipeline([["SET", lockKey(store.statsId), "1", "NX", "EX", BOOK_LOCK_SECONDS]]);
    return got === "OK";
  } catch {
    return false;
  }
}

export async function releaseRefresh(store: Store): Promise<void> {
  if (!store.statsId) return;
  await redisPipeline([["DEL", lockKey(store.statsId)]]).catch(() => undefined);
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
 * Keeps the whole program's book, each approved affiliate's part under their
 * own field, and when it was worked out last of all. False when it is past
 * BOOK_SNAPSHOT_MAX_BYTES (nothing written) or could not be written.
 */
export async function writeSnapshot(store: Store, book: Book, at: number): Promise<boolean> {
  if (!store.statsId) return false;
  const key = snapshotKey(store.statsId);
  const parts = book.rows
    .filter((row) => row.affiliate.status === "approved")
    .map((row) => [row.affiliate.id, JSON.stringify({ at, book: bookSlice(book, row.affiliate.id) })] as const);
  const bytes = parts.reduce((sum, [, value]) => sum + value.length, 0);
  if (bytes > BOOK_SNAPSHOT_MAX_BYTES) return false;
  try {
    let round: string[] = [];
    let size = 0;
    const flush = async () => {
      if (!round.length) return;
      await redisPipeline([["HSET", key, ...round], ["EXPIRE", key, BOOK_KEEP_SECONDS]]);
      round = [];
      size = 0;
    };
    for (const [id, value] of parts) {
      if (size + value.length > WRITE_BYTES) await flush();
      round.push(id, value);
      size += value.length;
    }
    await flush();
    await redisPipeline([["HSET", key, AT, String(at)], ["EXPIRE", key, BOOK_KEEP_SECONDS]]);
    return true;
  } catch {
    return false;
  }
}

/** Works the whole program's book out and keeps it; the book itself whether or not it could be kept. */
export async function refreshBook(store: Store, at: number): Promise<Book> {
  const book = await readBook(store);
  await writeSnapshot(store, book, at);
  return book;
}
