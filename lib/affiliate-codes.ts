/**
 * Crediting a sale to the affiliate whose discount code the buyer typed.
 *
 * Why this exists. Every affiliate programme in this business — Hotmart's,
 * Stan's, Kajabi's, and ours until now — credits a sale from a cookie dropped
 * when somebody clicks a link. That works for a link in a bio and nowhere
 * else. An affiliate who reads a code out on a podcast, says it from a stage,
 * prints it in a PDF, or puts it in the caption of a video that does not take
 * links, produces no click at all, so there is no cookie and no commission —
 * and the sale they made is credited to nobody. Safari takes the rest: it
 * holds a first-party cookie written by a script for seven days, and caps the
 * life of cookies generally, so even a real click can be gone before a buyer
 * who thinks about it for a fortnight comes back.
 *
 * A code has none of those problems. It is said out loud, it is remembered, it
 * survives any browser, and it is typed by the buyer themselves at the moment
 * they pay. So a creator may hand one of their own discount codes to one
 * affiliate, and any sale that used it earns that affiliate their share, cookie
 * or no cookie.
 *
 * What this does not do, on purpose:
 *
 *   - it does not make the code. The codes are the creator's own, already on
 *     their own Stripe account (lib/discount.ts): a Coupon and a Promotion
 *     Code that belong to them, that they can see in their own dashboard, and
 *     that they take with them if they leave. All that is kept here is which
 *     affiliate a code was given to;
 *   - it does not price anything. Stripe decides what the code takes off, at
 *     the moment the buyer types it. The commission is then worked out on
 *     what was actually paid, like every other commission here;
 *   - it never overrides a click. A sale that already carries an affiliate
 *     from the cookie keeps that affiliate. The code is read only when the
 *     cookie had nothing to say, which is the whole case it is here for.
 *
 * One record, under the store's own stats id so it moves with the store:
 *
 *   nl:aff:<id>:promo   hash  Stripe promotion code id -> affiliate id
 */
import { isRedisConfigured, redisPipeline } from "@/lib/redis";
import { giveData, needData } from "@/lib/store-data";
import { dataBytes } from "@/lib/store-data-rules";
import type { Store } from "@/lib/store";

/** Stripe's id for a promotion code: the thing a buyer's code resolves to. */
export const PROMO_ID_PATTERN = /^promo_[A-Za-z0-9]{10,80}$/;

const promoKey = (statsId: string) => `nl:aff:${statsId}:promo`;

/** How many codes are given to affiliates, counted with one command before the page reads them (lib/affiliate-page-admission.ts). */
export async function codeOwnerCount(store: Store): Promise<number | null> {
  if (!store.statsId || !isRedisConfigured()) return 0;
  try {
    const [n] = await redisPipeline([["HLEN", promoKey(store.statsId)]]);
    const count = Number(n);
    return Number.isSafeInteger(count) && count >= 0 ? count : null;
  } catch {
    return null;
  }
}

/** A Redis hash reply, as pairs, in either shape a client returns it. */
function pairs(reply: unknown): [string, string][] {
  const out: [string, string][] = [];
  if (Array.isArray(reply)) {
    const list = reply.map(String);
    for (let i = 0; i + 1 < list.length; i += 2) out.push([list[i], list[i + 1]]);
  } else if (reply && typeof reply === "object") {
    for (const [k, v] of Object.entries(reply as Record<string, unknown>)) out.push([k, String(v)]);
  }
  return out;
}

/**
 * Which affiliate each of this store's codes was given to, by Stripe's
 * promotion code id. Empty for a store that has given none away, which is
 * every store until its creator does.
 */
export async function codeOwners(store: Store): Promise<Map<string, string>> {
  if (!store.statsId || !isRedisConfigured()) return new Map();
  const [reply] = await redisPipeline([["HGETALL", promoKey(store.statsId)]]);
  return new Map(pairs(reply).filter(([id]) => PROMO_ID_PATTERN.test(id)));
}

/**
 * Gives a code to an affiliate, replacing whoever had it before. A code
 * belongs to one affiliate at a time: two people sharing one code cannot be
 * told apart by the thing that is supposed to tell them apart.
 */
export async function giveCode(store: Store, promoId: string, affiliateId: string): Promise<boolean> {
  if (!store.statsId || !isRedisConfigured()) return false;
  if (!PROMO_ID_PATTERN.test(promoId) || !/^[0-9a-f]{12}$/.test(affiliateId)) return false;
  // A code given for the first time takes room in the store's data room (DataRoomError when it does not fit).
  const [held] = await redisPipeline([["HEXISTS", promoKey(store.statsId), promoId]]);
  if (Number(held) !== 1) await needData(store, [{ slot: CODES_SLOT, bytes: dataBytes([promoId, affiliateId], 1) }]);
  await redisPipeline([["HSET", promoKey(store.statsId), promoId, affiliateId]]);
  return true;
}

/** Takes a code back, and gives back its room. Sales already credited through it stay credited. */
export async function takeCodeBack(store: Store, promoId: string): Promise<boolean> {
  if (!store.statsId || !isRedisConfigured() || !PROMO_ID_PATTERN.test(promoId)) return false;
  const [held, removed] = await redisPipeline([["HGET", promoKey(store.statsId), promoId], ["HDEL", promoKey(store.statsId), promoId]]);
  if (Number(removed) === 1 && typeof held === "string") await giveData(store, [{ slot: CODES_SLOT, bytes: dataBytes([promoId, held], 1) }]);
  return Number(removed) === 1;
}

/** Where the codes given to affiliates are counted in the store's data room (lib/store-data.ts). */
const CODES_SLOT = "aff:codes";

type DiscountLike = { promotion_code?: unknown } | null | undefined;

/**
 * The promotion code ids a settled order used, as Stripe reports them on the
 * order itself. Stripe lists at most one discount on a Checkout Session today,
 * but it is an array, so this reads it as one.
 *
 * A discount the creator applied themselves — a sale price, a save-offer
 * coupon (lib/save-offer-coupon.ts) — is a bare coupon with no promotion code,
 * and so is passed over here rather than credited to anybody.
 */
export function promoCodesOn(order: { discounts?: unknown }): string[] {
  const list = Array.isArray(order.discounts) ? (order.discounts as DiscountLike[]) : [];
  const out: string[] = [];
  for (const row of list) {
    const raw = row?.promotion_code;
    const id = typeof raw === "string" ? raw : typeof (raw as { id?: unknown })?.id === "string" ? ((raw as { id: string }).id) : "";
    if (PROMO_ID_PATTERN.test(id) && !out.includes(id)) out.push(id);
  }
  return out;
}

/**
 * The affiliate a settled order belongs to because of the code typed into it,
 * or "" when no code on it was given to anybody.
 *
 * `owners` is passed in rather than read here so a sweep over a hundred orders
 * reads the store's codes once.
 */
export function affiliateForCodes(order: { discounts?: unknown }, owners: Map<string, string>): string {
  if (!owners.size) return "";
  for (const id of promoCodesOn(order)) {
    const affiliate = owners.get(id);
    if (affiliate) return affiliate;
  }
  return "";
}
