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
import { UnknownReplyError, countOf, repliesFor, stringList } from "@/lib/redis-reply";
import { DataRoomError, TAKE_DATA, dataKey, dataTakenOf, giveData, monthOf } from "@/lib/store-data";
import { contentRoomFor, dataBytes } from "@/lib/store-data-rules";
import type { Store } from "@/lib/store";

/** Stripe's id for a promotion code: the thing a buyer's code resolves to. */
export const PROMO_ID_PATTERN = /^promo_[A-Za-z0-9]{10,80}$/;

const promoKey = (statsId: string) => `nl:aff:${statsId}:promo`;

/**
 * How many codes are given to affiliates, counted with one command before the page reads them
 * (lib/affiliate-page-admission.ts). Read exactly (CX-123 rule 24): one whole number from zero up for the one
 * command, or null, which the page takes as refused; a null, "", false or "2" reply is never a count of 0.
 */
export async function codeOwnerCount(store: Store): Promise<number | null> {
  if (!store.statsId || !isRedisConfigured()) return 0;
  try {
    return countOf(repliesFor(await redisPipeline([["HLEN", promoKey(store.statsId)]]), 1)?.[0]);
  } catch {
    return null;
  }
}

/**
 * The HGETALL reply as pairs, read exactly (CX-123 rule 24): one reply for the one command, a list of strings with
 * an even count, or UnknownReplyError. HGETALL answers an empty list for a hash with nothing in it, so a reply
 * missing, cut short or of another shape is never "no code given to anybody" (audit R24 round 5, finding 2).
 */
function pairsExact(replies: unknown): [string, string][] {
  const list = stringList(repliesFor(replies, 1)?.[0]);
  if (!list || list.length % 2 !== 0) throw new UnknownReplyError("the codes given to affiliates");
  const out: [string, string][] = [];
  for (let i = 0; i < list.length; i += 2) out.push([list[i], list[i + 1]]);
  return out;
}

/**
 * Which affiliate each of this store's codes was given to, by Stripe's
 * promotion code id. Empty for a store that has given none away, which is
 * every store until its creator does. Throws UnknownReplyError when the codes
 * could not be read exactly: a sale made with a code must not fall through to
 * the buyer's bond or a lead (written once, for ever) on a reply nobody
 * understood, so it waits for a pass that reads them.
 */
export async function codeOwners(store: Store): Promise<Map<string, string>> {
  if (!store.statsId || !isRedisConfigured()) return new Map();
  const pairs = pairsExact(await redisPipeline([["HGETALL", promoKey(store.statsId)]]));
  return new Map(pairs.filter(([id]) => PROMO_ID_PATTERN.test(id)));
}

/** A one-field HDEL reply, read exactly (CX-123 rule 24): 0 or 1, else UnknownReplyError. */
function oneOrNone(reply: unknown, what: string): 0 | 1 {
  const n = countOf(reply);
  if (n !== 0 && n !== 1) throw new UnknownReplyError(what);
  return n;
}

/**
 * Gives a code to an affiliate, replacing whoever had it before. A code
 * belongs to one affiliate at a time: two people sharing one code cannot be
 * told apart by the thing that is supposed to tell them apart.
 *
 * Whether the code is held, its room and the write are one step (GIVE_CODE; Claude 2's MEDIUM on #3300): read in
 * separate steps, a take-back landing between the HEXISTS and the HSET left the code held with its room not counted,
 * and two first gives at once took the room twice. A code given for the first time takes room in the store's data
 * room (DataRoomError when it does not fit, and nothing is written); a move takes none.
 *
 * The script's reply is read exactly (CX-123 rule 24; audit R24 round 8, finding 2): {2, 0} moved, {1, total} given
 * with its room, {0, total} full; anything else throws UnknownReplyError, which the route answers as 503
 * "unavailable". Never true on a reply nobody understood: a code moved from one affiliate to another and not written
 * keeps crediting the first one's sales, so the creator must not be told it moved. What a script that did run took
 * stays taken, which errs toward room counted, never toward room missing.
 */
export async function giveCode(store: Store, promoId: string, affiliateId: string): Promise<boolean> {
  if (!store.statsId || !isRedisConfigured()) return false;
  if (!PROMO_ID_PATTERN.test(promoId) || !/^[0-9a-f]{12}$/.test(affiliateId)) return false;
  const room = dataKey(store);
  if (!room) throw new Error("the store's data room could not be counted");
  const now = Date.now();
  const reply = repliesFor(await redisPipeline([["EVAL", GIVE_CODE, 2, room, promoKey(store.statsId), contentRoomFor(store, now / 1000), monthOf(now), dataBytes([promoId, affiliateId], 1), promoId, affiliateId]]), 1)?.[0];
  if (Array.isArray(reply) && reply.length === 2 && reply[0] === 2 && reply[1] === 0) return true;
  const taken = dataTakenOf(store, reply, now / 1000);
  if (taken.ok) return true;
  if (taken.reason === "full") throw new DataRoomError(taken);
  throw new UnknownReplyError("giving an affiliate a code");
}

/**
 * Takes a code back, and gives back its room. Sales already credited through it stay credited. The HGET and HDEL
 * replies are read exactly (rule 30 of the fix above): a confirmed 0 is "not held" (false), a confirmed 1 gives back
 * the room of the affiliate id read beside it, and any other shape throws UnknownReplyError rather than "not held".
 */
export async function takeCodeBack(store: Store, promoId: string): Promise<boolean> {
  if (!store.statsId || !isRedisConfigured() || !PROMO_ID_PATTERN.test(promoId)) return false;
  const replies = repliesFor(await redisPipeline([["HGET", promoKey(store.statsId), promoId], ["HDEL", promoKey(store.statsId), promoId]]), 2);
  const held = replies?.[0];
  if (held !== null && typeof held !== "string") throw new UnknownReplyError("the affiliate a code was given to");
  const removed = oneOrNone(replies?.[1], "taking a code back from an affiliate");
  if (removed === 1 && typeof held === "string") await giveData(store, [{ slot: CODES_SLOT, bytes: dataBytes([promoId, held], 1) }]);
  return removed === 1;
}

/** Where the codes given to affiliates are counted in the store's data room (lib/store-data.ts). */
const CODES_SLOT = "aff:codes";

/**
 * KEYS[1] the store's data room, KEYS[2] the codes hash; ARGV the room's limit, this month, the code's bytes, the
 * promotion code id and the affiliate id. A code already held is moved (HSET over it) and answers {2, 0}, taking no
 * room. A code not held takes its room with the data room's own steps (TAKE_DATA, slot CODES_SLOT) and is written
 * only when that answers {1, total}; {0, total} (full) and {-1, total} write nothing. One step, so nothing can land
 * between the check, the room and the write. Modelled by lib/redis-memory.ts.
 */
export const GIVE_CODE = `-- marktmorgen:affiliate-code-give:v1
local function codeRoom(limit, month, bytes)
  local KEYS = {KEYS[1]}
  local ARGV = {limit, '0', month, 'a', '${CODES_SLOT}', bytes}
${TAKE_DATA}
end
if redis.call('HEXISTS', KEYS[2], ARGV[4]) == 1 then
  redis.call('HSET', KEYS[2], ARGV[4], ARGV[5])
  return {2, 0}
end
local taken = codeRoom(ARGV[1], ARGV[2], ARGV[3])
if taken[1] ~= 1 then return taken end
redis.call('HSET', KEYS[2], ARGV[4], ARGV[5])
return taken`;

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
