/**
 * The series of calls a store has running (637 [GL5]; C2-94, added 4
 * November 2026): one sorted set per store's call diary (its callsId), each
 * member a series' id, scored by the end of its last session.
 *
 * Read by the currency route, which refuses to change the store's currency
 * while one runs (app/api/store/currency/route.ts): each series is charged
 * in the currency it was booked in (lib/call-series-billing.ts,
 * ChargeRecord.currency), and the store's pages would otherwise state its
 * sessions in another one. Written by the unit that books a series
 * (markSeriesOpen, again with the new end when its last session moves) and
 * the one that ends it early (markSeriesEnded), both through
 * lib/order-data.ts, so the store's data room is charged what each member
 * adds. A series whose last session has ended is not counted, and is
 * removed at the store's next write here, its bytes given back to the room
 * (seriesReleaseBytes); until then it stays with the store, one member per
 * series booked (tests/store-data-registry.ts).
 *
 * A series booked while the currency is being changed keeps the currency
 * it read at booking, whichever wins: its own records carry it, so nothing
 * is charged in another currency even then.
 */
import { redisPipeline } from "@/lib/redis";
import { orderWrite, releaseOrderData } from "@/lib/order-data";
import { DATA_STEP_BYTES } from "@/lib/store-data-rules";
import type { Store } from "@/lib/store";

export const seriesOpenKey = (callsId: string) => `nl:call:series:${callsId}`;

/** A series' id: 32 hex characters, so every member weighs the same and what a removal gives back is known. */
export const SERIES_ID_PATTERN = /^[0-9a-f]{32}$/;

/**
 * What removing one member gives back to the room: what lib/order-data.ts
 * charged its ZADD (the member, 8 bytes of score and 128 of entry, a quarter
 * more), rounded down, so a removal never gives back more than the write
 * took.
 */
export function seriesReleaseBytes(): number {
  return Math.floor(((32 + 8 + 128) * 5) / 4 / DATA_STEP_BYTES) * DATA_STEP_BYTES;
}

/** Removes the members whose series is over at `now` and gives their bytes back to the room. */
async function tidy(store: Store & { callsId: string }, now: number): Promise<void> {
  // One step: only what this call removed is counted, so two writers never give the same member back twice.
  const [gone] = await redisPipeline([["ZREMRANGEBYSCORE", seriesOpenKey(store.callsId), "-inf", now]]);
  await releaseOrderData(store, (Number(gone) || 0) * seriesReleaseBytes());
}

/** How many series of the store have a session not yet over at `now` (their last session ends after it). */
export async function runningSeries(store: Pick<Store, "callsId">, now = Date.now()): Promise<number> {
  if (!store.callsId) return 0;
  const [count] = await redisPipeline([["ZCOUNT", seriesOpenKey(store.callsId), `(${now}`, "+inf"]]);
  return Number(count) || 0;
}

/**
 * A series booked, or its last session moved: running until `lastEnd`, the
 * end of its last session in milliseconds, after `now`. Refuses an id that
 * is not 32 hex characters or an end that is not a whole number of
 * milliseconds in the future (seconds would read as long past). Series over
 * are removed first.
 */
export async function markSeriesOpen(store: Store & { callsId: string }, seriesId: string, lastEnd: number, now = Date.now()): Promise<void> {
  if (!SERIES_ID_PATTERN.test(seriesId)) throw new Error("markSeriesOpen: a series id is 32 hex characters");
  if (!Number.isSafeInteger(lastEnd) || lastEnd <= now) throw new Error("markSeriesOpen: the last session's end must be a time in milliseconds after now");
  await tidy(store, now);
  await orderWrite(store, [["ZADD", seriesOpenKey(store.callsId), lastEnd, seriesId]]);
}

/** A series ended before its last session (canceled by the buyer or the creator): no longer running. */
export async function markSeriesEnded(store: Store & { callsId: string }, seriesId: string, now = Date.now()): Promise<void> {
  const [gone] = await redisPipeline([["ZREM", seriesOpenKey(store.callsId), seriesId]]);
  await releaseOrderData(store, (Number(gone) || 0) * seriesReleaseBytes());
  await tidy(store, now);
}
