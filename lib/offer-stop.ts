/**
 * A creator's stop for the offers Marktmorgen itself emails them (added 15 November 2026, Claude 7's outgoing-email
 * audit): today the yearly plan's offer at a store's first sale (lib/yearly-offer.ts). Such an email is commercial,
 * so it carries a working way to stop it and the company's postal address (15 U.S.C. 7704(a)(3) and (a)(5)): a link
 * signed for the store, which a mail app can also press in one click (List-Unsubscribe-Post, RFC 8058), at
 * app/api/store/offers/route.ts. A stop is kept in one set for every store, by the store's id, so a new address
 * (handle) keeps it.
 *
 * Read exactly (CX-123 rule 24): a stop whose answer is not a whole 0 or 1 is unknown, and nothing is sent on it.
 */
import { createHmac, timingSafeEqual } from "node:crypto";
import { isRedisConfigured, redisPipeline } from "@/lib/redis";
import { UnknownReplyError, repliesFor } from "@/lib/redis-reply";
import { deriveKey } from "@/lib/secret-box";
import { SITE_URL } from "@/lib/site-url";

/** The stores whose creators stopped Marktmorgen's offers, by store id. */
export const OFFERS_OFF = "nl:offers:off";

const STORE_ID = /^[0-9a-f]{32}$/;

/** The token signed for one store's stop link; "" when no key is set (then no link can be made, and no offer is sent). */
export function offersToken(sid: string): string {
  const key = deriveKey("offers-stop");
  if (!key || !STORE_ID.test(sid)) return "";
  return createHmac("sha256", key).update(`offers|${sid}`).digest("base64url").slice(0, 32);
}

export function offersTokenOk(sid: string, token: string): boolean {
  const want = offersToken(sid);
  if (!want || token.length !== want.length) return false;
  return timingSafeEqual(Buffer.from(want), Buffer.from(token));
}

/** The stop link for one store, or null when it cannot be signed. */
export function offersStopUrl(sid: string): string | null {
  const token = offersToken(sid);
  return token ? `${SITE_URL}/api/store/offers?s=${encodeURIComponent(sid)}&t=${encodeURIComponent(token)}` : null;
}

/** Whether a store's creator stopped the offers: true, false, or "unknown" when the answer is not a whole 0 or 1. */
export async function offersStopped(sid: string): Promise<boolean | "unknown"> {
  if (!isRedisConfigured() || !STORE_ID.test(sid)) return "unknown";
  try {
    const read = repliesFor(await redisPipeline([["SISMEMBER", OFFERS_OFF, sid]]), 1);
    if (!read || (read[0] !== 0 && read[0] !== 1)) return "unknown";
    return read[0] === 1;
  } catch {
    return "unknown";
  }
}

/** Stops the offers for a store; throws when the write's answer is not exactly 0 or 1, so a stop is never said unconfirmed. */
export async function stopOffers(sid: string): Promise<void> {
  if (!isRedisConfigured() || !STORE_ID.test(sid)) throw new UnknownReplyError("an offers stop");
  const wrote = repliesFor(await redisPipeline([["SADD", OFFERS_OFF, sid]]), 1);
  if (!wrote || (wrote[0] !== 0 && wrote[0] !== 1)) throw new UnknownReplyError("an offers stop");
}
