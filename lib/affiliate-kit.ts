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
import { windowId } from "@/lib/allowance-window";
import { reservePaidResourceWindow } from "@/lib/contract-resource-window";
import { randomUUID } from "node:crypto";
import { affiliateCampaignLink } from "@/lib/affiliate-promotion";
import { isRedisConfigured, redisPipeline } from "@/lib/redis";
import type { Store } from "@/lib/store";
import { type Affiliate, affiliatesOn } from "@/lib/affiliates";
import { commissionRate } from "@/lib/affiliate-setting";
import { readListing, type Listing } from "@/lib/catalog";
import { readAbout } from "@/lib/product-about";
import { readPage } from "@/lib/sales-page-store";
import { pageShown } from "@/lib/sales-page";
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
  const [today, , thisMonth, , storeMonth] = await redisPipeline([
    ["INCR", day],
    ["EXPIRE", day, 2 * 86_400],
    ["INCR", month],
    ["EXPIRE", month, 40 * 86_400],
    ["INCR", jobs],
    ["EXPIRE", jobs, 40 * 86_400],
  ]);
  if (![today, thisMonth, storeMonth].every(value => (typeof value === "number" || (typeof value === "string" && /^\d+$/.test(value))) && Number.isSafeInteger(Number(value)) && Number(value) >= 1)) return { ok: false, reason: "off" };
  const giveBack = () => redisPipeline([["DECR", day], ["DECR", month], ["DECR", jobs]]).catch(() => null);
  if (Number(today) > KIT_PER_DAY) {
    await giveBack();
    return { ok: false, reason: "day" };
  }
  if (Number(thisMonth) > kitMonthly(allowance) || Number(storeMonth) > allowance) {
    await giveBack();
    return { ok: false, reason: "month" };
  }
  let posts: AffiliatePosts | null = null;
  try {
    const [about, page] = await Promise.all([readAbout(store.statsId, product.id).catch(() => ""), readPage(store.statsId, product.id).catch(() => null)]);
    posts = await writeAffiliatePosts(store, { facts: factsFor(store, product, about, page && pageShown(page) ? page : null), note });
  } catch (error) {
    console.error("drafting an affiliate's posts failed", error);
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
