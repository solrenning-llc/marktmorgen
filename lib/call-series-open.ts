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
 * adds. A series whose last session has ended is simply not counted; its
 * member stays with the store, one per series booked, like the booking it
 * came with (tests/store-data-registry.ts).
 *
 * A series booked while the currency is being changed keeps the currency
 * it read at booking, whichever wins: its own records carry it, so nothing
 * is charged in another currency even then.
 */
import { redisPipeline } from "@/lib/redis";
import { type DataOwner, orderWrite } from "@/lib/order-data";
import type { Store } from "@/lib/store";

export const seriesOpenKey = (callsId: string) => `nl:call:series:${callsId}`;

/** How many series of the store have a session not yet over at `now` (their last session ends after it). */
export async function runningSeries(store: Pick<Store, "callsId">, now = Date.now()): Promise<number> {
  if (!store.callsId) return 0;
  const [count] = await redisPipeline([["ZCOUNT", seriesOpenKey(store.callsId), `(${now}`, "+inf"]]);
  return Number(count) || 0;
}

/** A series booked, or its last session moved: running until `lastEnd` (ms). */
export async function markSeriesOpen(store: DataOwner & { callsId: string }, seriesId: string, lastEnd: number): Promise<void> {
  await orderWrite(store, [["ZADD", seriesOpenKey(store.callsId), lastEnd, seriesId]]);
}

/** A series ended before its last session (canceled by the buyer or the creator): no longer running. */
export async function markSeriesEnded(store: DataOwner & { callsId: string }, seriesId: string): Promise<void> {
  await orderWrite(store, [["ZREM", seriesOpenKey(store.callsId), seriesId]]);
}
