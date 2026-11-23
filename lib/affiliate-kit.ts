/**
 * Posts for an affiliate, on the server (lib/affiliate-kit-rules.ts has the
 * why). Checks who is asking and for what, holds the store to its limits,
 * reads the product's page as the public reads it, asks the model, and adds
 * the affiliate's own link and the line that says they earn from it.
 *
 *   nl:affkit:<statsId>:<affiliate>:<YYYY-MM-DD>   drafts one affiliate asked for that day
 *   nl:affkit:<statsId>:<YYYY-MM>                  drafts the store's affiliates asked for that month
 *   nl:ai:<statsId>:<YYYY-MM>                      the store's month of writing jobs, which each draft is one of (lib/ai.ts)
 */
import { windowId, windowKeySeconds } from "@/lib/allowance-window";
import { reservePaidResourceWindow } from "@/lib/contract-resource-window";
import { randomUUID } from "node:crypto";
import { affiliateCampaignLink } from "@/lib/affiliate-promotion";
import { isRedisConfigured, redisPipeline } from "@/lib/redis";
import { type Store } from "@/lib/store";
import { storeLiveFence } from "@/lib/store-live-cache";
import { repliesFor } from "@/lib/redis-reply";
import { type Affiliate, affiliatesOn } from "@/lib/affiliates";
import { commissionRate } from "@/lib/affiliate-setting";
import { readListing, type Listing } from "@/lib/catalog";
import { readAbout } from "@/lib/product-about";
import { readPage } from "@/lib/sales-page-store";
import { pageShown, type SalesPage } from "@/lib/sales-page";
import { factsFor } from "@/lib/answers";
import { aiAllowance, aiAvailableFor, aiMonthKey, writeAffiliatePosts } from "@/lib/ai";
import { storeBase } from "@/lib/purchase-email";
import { productSegment } from "@/lib/product-slug";
import { DISCLOSURE, DISCLOSURE_SHORT, KIT_PER_DAY, MAX_KIT_NOTE, type AffiliatePosts, finishPost, kitMonthly } from "@/lib/affiliate-kit-rules";

const dayKey = (store: Store, affiliate: Affiliate, now: Date) => `nl:affkit:${store.statsId}:${affiliate.id}:${now.toISOString().slice(0, 10)}`;
/** Kits drafted in the store's window (lib/allowance-window.ts); null when none is known. */
const monthKey = (store: Store, now: Date): string | null => {
  const window = windowId(store, now.getTime());
  return window ? `nl:affkit:${store.statsId}:${window}` : null;
};

/**
 * A product an affiliate earns on: paid, on the store, and not left out at 0%
 * for them; sold once (paid in full, also when a payment plan is offered), or
 * a membership when the store credits memberships (397 [SL1], as the
 * affiliate directory lists them).
 */
export function kitProduct(store: Store, affiliate: Affiliate, listing: Listing | null): listing is Listing {
  return Boolean(
    listing &&
      listing.priceCents > 0 &&
      !listing.hidden &&
      (!listing.recurring || store.affiliates.recurring > 0) &&
      commissionRate(store.affiliates, listing.id, affiliate.rate) > 0,
  );
}

/** The affiliate's link to one product's own page. */
export function productAffiliateLink(store: Store, product: Pick<Listing, "id" | "title">, code: string): string {
  return `${storeBase(store)}/p/${productSegment(product)}?via=${code}`;
}

export type KitResult = { ok: true; posts: AffiliatePosts; left: number } | { ok: false; reason: "off" | "unknown" | "day" | "month" | "failed" | "unavailable" };

/**
 * The page a kit is written from: the page as visitors see it, null when it keeps nothing from them, or "unread" when
 * its read's answer is not known, so no post is drafted from facts with the page left out (C4-20261106-2610-C6-153,
 * unit B). The same one read as before.
 */
export async function kitPageRead(store: Store, product: Listing): Promise<SalesPage | null | "unread"> {
  try {
    const page = await readPage(store.statsId, product.id);
    return pageShown(page) ? page : null;
  } catch {
    return "unread";
  }
}

/**
 * The kit's three counters (the affiliate's day, the program's window, the store's writing jobs), taken and given back
 * only while the store is still its own and not erasing, in one step (Codex P-20261120-1412): a kit drafted on a Store
 * read before the store's erasure, or its move, never writes these erased families back, as counters of 1 or, given
 * back, of -1 with no expiry. KEYS: the store's live key (its id key, or its record from before ids), the erasing hash,
 * then the three counters; ARGV: the store's erasing field, "take" or "back", the day's and the window's seconds, the
 * statsId its record must carry ("" for a store with an id, whose id key must hold ARGV[6], its ref). The identity rule
 * of SET_IF_STORE_LIVE (lib/live-fence.ts). "take": {1, day, window, jobs} once all three are counted. "back": only
 * while all three are still there and above zero, each one less, so a counter that lapsed or went with the erasure is
 * never made again; {1} when given back, {2} when not. {0} when the store is gone or erasing, {-1} when its owner's
 * record does not read. Its worst is KIT_COMMANDS_MOST with the content reads.
 */
export const KIT_COUNTS = `-- marktmorgen:affiliate-kit-counts:v1
if redis.call("HGET", KEYS[2], ARGV[1]) then return {0} end
if ARGV[5] == "" then
  if redis.call("GET", KEYS[1]) ~= ARGV[6] then return {0} end
else
  local raw = redis.call("GET", KEYS[1])
  if not raw then return {0} end
  local ok, record = pcall(cjson.decode, raw)
  if not ok or type(record) ~= "table" then return {-1} end
  if record["statsId"] ~= ARGV[5] then return {0} end
end
if ARGV[2] == "take" then
  local day = redis.call("INCR", KEYS[3])
  redis.call("EXPIRE", KEYS[3], ARGV[3])
  local window = redis.call("INCR", KEYS[4])
  redis.call("EXPIRE", KEYS[4], ARGV[4])
  local jobs = redis.call("INCR", KEYS[5])
  redis.call("EXPIRE", KEYS[5], ARGV[4])
  return {1, day, window, jobs}
end
local held = redis.call("MGET", KEYS[3], KEYS[4], KEYS[5])
for i = 1, 3 do
  if not held[i] or tonumber(held[i]) == nil or tonumber(held[i]) < 1 then return {2} end
end
redis.call("DECR", KEYS[3])
redis.call("DECR", KEYS[4])
redis.call("DECR", KEYS[5])
return {1}`;

/** One run of KIT_COUNTS for this store; null when its answer is not one KIT_COUNTS gives. */
async function kitCounts(store: Store, op: "take" | "back", keys: [string, string, string], daySeconds: number, windowSeconds: number): Promise<number[] | null> {
  // The shared fence (lib/store-live-cache.ts), never a copy of it (Claude 4 3Kc's LEVE on #5101): a store from before
  // ids with no statsId is told from its owner's next store by nothing, so nothing is counted.
  const fence = await storeLiveFence(store);
  if (fence.statsId === null) return null;
  const reply = repliesFor(await redisPipeline([["EVAL", KIT_COUNTS, 5, fence.live, fence.erasing, ...keys, fence.field, op, daySeconds, windowSeconds, fence.statsId, fence.ref]]), 1)?.[0];
  if (!Array.isArray(reply) || !reply.every((n) => typeof n === "number" && Number.isSafeInteger(n))) return null;
  return reply as number[];
}

/** Drafts one affiliate's three posts about one product, within the limits. */
export async function draftKit(store: Store, affiliate: Affiliate, productId: string, rawNote: string, now = new Date()): Promise<KitResult> {
  if (!aiAvailableFor(store) || !isRedisConfigured() || !store.statsId || !affiliatesOn(store) || !store.affiliates.kit || affiliate.status !== "approved") return { ok: false, reason: "off" };
  const product = await readListing(store, productId);
  if (!kitProduct(store, affiliate, product)) return { ok: false, reason: "unknown" };
  if (store.period?.funded === true && !(await reservePaidResourceWindow(store))) return { ok: false, reason: "unavailable" };
  const note = rawNote.replace(/\s+/g, " ").trim().slice(0, MAX_KIT_NOTE);
  const allowance = aiAllowance(store, now.getTime());
  if (!Number.isSafeInteger(allowance) || allowance < 0) return { ok: false, reason: "off" };
  const day = dayKey(store, affiliate, now);
  const month = monthKey(store, now);
  const jobs = aiMonthKey(store, now);
  if (!month || !jobs) return { ok: false, reason: "month" };
  // Kept at least as long as the window they are counted in (Claude 6 on #4561).
  const kept = windowKeySeconds(store, 40 * 86_400, now.getTime());
  // Counted only while the store is still its own and not erasing (Codex P-20261120-1412): nothing is written, and no
  // model is asked, for a store that went while this request read.
  const counters: [string, string, string] = [day, month, jobs];
  const taken = await kitCounts(store, "take", counters, 2 * 86_400, kept).catch(() => null);
  if (taken?.[0] === 0) return { ok: false, reason: "unavailable" };
  if (!taken || taken[0] !== 1 || taken.length !== 4 || !taken.slice(1).every((n) => n >= 1)) return { ok: false, reason: "off" };
  const [, today, thisMonth, storeMonth] = taken;
  const giveBack = () => kitCounts(store, "back", counters, 2 * 86_400, kept).catch(() => null);
  if (Number(today) > KIT_PER_DAY) {
    await giveBack();
    return { ok: false, reason: "day" };
  }
  if (Number(thisMonth) > kitMonthly(allowance) || Number(storeMonth) > allowance) {
    await giveBack();
    return { ok: false, reason: "month" };
  }
  let posts: AffiliatePosts | null = null;
  let unread = false;
  try {
    const [about, page] = await Promise.all([readAbout(store.statsId, product.id).catch(() => ""), kitPageRead(store, product)]);
    if (page === "unread") unread = true;
    else posts = await writeAffiliatePosts(store, { facts: factsFor(store, product, about, page), note });
  } catch (error) {
    console.error("drafting an affiliate's posts failed", error);
  }
  // The page could not be read: nothing was drafted or spent, so the day's and the month's counts go back.
  if (unread) {
    await giveBack();
    return { ok: false, reason: "unavailable" };
  }
  // Started work may be billed even when no usable text comes back.
  if (!posts) return { ok: false, reason: "failed" };
  const link = productAffiliateLink(store, product, affiliate.code);
  const full = DISCLOSURE[store.language] ?? DISCLOSURE.en;
  const variant = `kit-${randomUUID().replaceAll("-", "")}`;
  const tagged = (source: string) => affiliateCampaignLink(link, affiliate.code, source, `affiliate-${affiliate.code}`, "post", variant);
  return {
    ok: true,
    posts: {
      x: finishPost(posts.x, tagged("x"), DISCLOSURE_SHORT[store.language] ?? DISCLOSURE_SHORT.en),
      instagram: finishPost(posts.instagram, tagged("instagram"), full),
      linkedin: finishPost(posts.linkedin, tagged("linkedin"), full),
    },
    left: Math.max(0, KIT_PER_DAY - Number(today)),
  };
}
