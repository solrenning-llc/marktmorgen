import type { Store } from "@/lib/store";
import { idsOfKind } from "@/lib/catalog";
import { boughtByToken } from "@/lib/call-packages";
import { isRedisConfigured, redisPipeline } from "@/lib/redis";
import { holdPublicRequests, takePublicRequest } from "@/lib/traffic";
import { BOOKING_SESSION, bookTimesUnits, bookingDiaryKey } from "@/lib/book-page-rules";

/**
 * What a booking page and the calendar embedded on a creator's site take of
 * the store's requests before they read a call's open times (traffic audit
 * and its pre-review, 9 November 2026; lib/book-page-rules.ts).
 */

/**
 * The open times paid for before anything of them is read: bookTimesUnits of
 * the store's requests. A public page holds them (lib/traffic.ts,
 * holdPublicRequests: refused past the public share, and then given back,
 * since nothing was read for them, so a page refused here never eats the
 * buyers' reserve); a buyer proved to hold the call (a package bought for it)
 * takes them from the whole window. False when they do not fit: then nothing
 * is read.
 */
export async function payBookTimes(store: Store, who: "public" | "buyer", now = Date.now()): Promise<boolean> {
  const units = bookTimesUnits(idsOfKind(store, "call").length);
  return who === "buyer" ? takePublicRequest(store, "buyer", now, units) : holdPublicRequests(store, units, now);
}

/**
 * The package a `?pkg=` token names, when it was bought for this store's call
 * (lib/call-packages.ts: two reads, the token's checkout and its record), or
 * null. Only such a package makes the page a buyer's.
 */
export async function packageFor(store: Store, productId: string, token: string): Promise<Awaited<ReturnType<typeof boughtByToken>>> {
  if (!token || !store.statsId) return null;
  const found = await boughtByToken(token).catch(() => null);
  return found && found.bought.s === store.statsId && found.bought.p === productId ? found : null;
}

/**
 * Whether a `?move=` session is a booking in this store's diary (one HEXISTS
 * on the field its hold or its payment wrote, lib/calls.ts), read exactly:
 * any answer but a single 1 is no proof, and the page stays the public one.
 */
export async function bookedHere(store: Store, session: string): Promise<boolean> {
  if (!BOOKING_SESSION.test(session) || !store.callsId || !isRedisConfigured()) return false;
  try {
    const reply = await redisPipeline([["HEXISTS", bookingDiaryKey(store.callsId), session]]);
    return Array.isArray(reply) && reply.length === 1 && reply[0] === 1;
  } catch {
    return false;
  }
}
