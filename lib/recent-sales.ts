/**
 * A store's latest purchases, shown on its own pages while the creator has
 * this switched on (Store.recentSales, added 13 October 2026): what
 * ClickFunnels sells as a "recent activity" pop-up, with the one difference
 * that matters. Theirs can be fed whatever the page owner types in; this one
 * can only show a payment Stripe settled on the creator's own account.
 *
 * What makes it true:
 *
 *   - a purchase is written down here only from a settled, live-mode checkout
 *     of this store (lib/sale-events.ts), for one of its own products, paid
 *     with real money: never a test payment, a free copy, a trial, a booked
 *     call or a tip, and nothing the creator can type;
 *   - it is shown for RECENT_DAYS and then no more, with the time it really
 *     happened; nothing is repeated to fill the space, and with no purchase
 *     in that time nothing is shown at all;
 *   - a payment refunded in any part, as the creator's Stripe account says,
 *     is left out; and when Stripe cannot be asked, nothing is shown, because
 *     an unchecked line is a line that might not be true;
 *   - a product the creator has since hidden or removed is left out.
 *
 * What it never says: who bought. Not a name, not a city, not a picture. The
 * country the card was billed in, when Stripe has it, and nothing finer.
 *
 * Records, under the store's own stats id:
 *
 *   nl:recent:<statsId>        list  the latest KEPT purchases, newest first
 *   nl:recent:feed:<statsId>   what the pages show, worked out at most every FEED_SECONDS
 */
import { isRedisConfigured, redisPipeline } from "@/lib/redis";
import { onAccount } from "@/lib/stripe-account";
import { KIND, readListings } from "@/lib/catalog";
import type { Store } from "@/lib/store";
import { RECENT_DAYS, type RecentSale, SHOWN } from "@/lib/recent-sales-rules";

/** How many are kept. */
const KEPT = 20;
/** How long the list the pages show is kept before it is worked out again. */
const FEED_SECONDS = 300;

const listKey = (statsId: string) => `nl:recent:${statsId}`;
const feedKey = (statsId: string) => `nl:recent:feed:${statsId}`;

/** One purchase as it is kept: the product, when, the billing country and the payment. */
type Kept = { p: string; at: number; c: string; pi: string };


/** A checkout as Stripe returns it, with only what is read here. */
export type RecentRecord = {
  id?: unknown;
  mode?: unknown;
  created?: unknown;
  amount_total?: unknown;
  payment_intent?: unknown;
  metadata?: Record<string, string> | null;
  customer_details?: { address?: { country?: unknown } | null } | null;
};

/** The checkout's payment, whether Stripe sent its id or the payment itself. */
function intentOf(record: RecentRecord): string {
  const pi = record.payment_intent;
  const id = typeof pi === "string" ? pi : pi && typeof pi === "object" ? (pi as { id?: unknown }).id : "";
  return typeof id === "string" && /^pi_[A-Za-z0-9]{6,}$/.test(id) ? id : "";
}

/** Whether a settled checkout may be shown as a purchase: real money, live, one of the store's own products. */
export function showable(record: RecentRecord, now = Date.now()): boolean {
  const meta = record.metadata ?? {};
  return (
    typeof record.id === "string" &&
    record.id.startsWith("cs_live_") &&
    record.mode === "payment" &&
    typeof record.created === "number" && Number.isSafeInteger(record.created) && record.created > 0 && record.created <= Math.floor(now / 1000) &&
    typeof record.amount_total === "number" && Number.isSafeInteger(record.amount_total) &&
    record.amount_total > 0 &&
    intentOf(record) !== "" &&
    typeof meta.product === "string" &&
    meta.product.length > 0 &&
    meta.kind !== "call" &&
    meta.kind !== "tip"
  );
}

/** Writes a settled checkout down, when it may be shown. Called once a checkout (lib/sale-events.ts). */
export async function rememberSale(store: Pick<Store, "statsId" | "recentSales">, record: RecentRecord): Promise<void> {
  if (!store.recentSales || !store.statsId || !isRedisConfigured() || !showable(record)) return;
  const country = record.customer_details?.address?.country;
  const kept: Kept = {
    p: (record.metadata ?? {}).product as string,
    at: record.created as number,
    c: typeof country === "string" && /^[A-Z]{2}$/.test(country) ? country : "",
    pi: intentOf(record),
  };
  await redisPipeline([
    ["LPUSH", listKey(store.statsId), JSON.stringify(kept)],
    ["LTRIM", listKey(store.statsId), 0, KEPT - 1],
    ["EXPIRE", listKey(store.statsId), (RECENT_DAYS + 1) * 86_400],
    // The pages read it afresh, so a purchase shows within the minute it is confirmed.
    ["DEL", feedKey(store.statsId)],
  ]);
}

function parseKept(raw: unknown): Kept | null {
  if (typeof raw !== "string") return null;
  try {
    const v = JSON.parse(raw) as Partial<Kept>;
    if (typeof v.p !== "string" || typeof v.pi !== "string" || typeof v.at !== "number") return null;
    return { p: v.p, at: v.at, c: typeof v.c === "string" ? v.c : "", pi: v.pi };
  } catch {
    return null;
  }
}

/** The payments on the creator's account refunded in any part since `since`, or null when Stripe could not say. */
async function refundedSince(account: string, since: number): Promise<Set<string> | null> {
  try {
    const listed = await onAccount("GET", account, `/refunds?limit=100&created[gte]=${since}`);
    // Only an explicitly complete list proves that no refund was omitted.
    // More than the requested page, or unknown evidence, cannot certify a sale.
    if (!listed || listed.object !== "list" || !Array.isArray(listed.data) || listed.data.length > 100 || listed.has_more !== false) return null;
    const refunded = new Set<string>();
    for (const row of listed.data) {
      if (!row || typeof row !== "object" || Array.isArray(row)) return null;
      const refund = row as Record<string, unknown>;
      if (typeof refund.status !== "string" || !["pending", "requires_action", "succeeded", "failed", "canceled"].includes(refund.status) ||
          typeof refund.payment_intent !== "string" || !/^pi_[A-Za-z0-9]{6,}$/.test(refund.payment_intent)) return null;
      if (refund.status !== "failed" && refund.status !== "canceled") refunded.add(refund.payment_intent);
    }
    return refunded;
  } catch (error) {
    console.error("reading refunds for recent purchases failed", error);
    return null;
  }
}

/**
 * What the store's pages show: up to SHOWN purchases of the last RECENT_DAYS,
 * newest first, refunds and hidden products left out. Empty when the switch is
 * off, when there is nothing to show, and when it could not be checked.
 */
export async function recentSales(store: Store, now = Date.now()): Promise<RecentSale[]> {
  if (!store.recentSales || !store.statsId || !store.stripeAccountId || !isRedisConfigured()) return [];
  const statsId = store.statsId;
  try {
    const [cached, list] = await redisPipeline([
      ["GET", feedKey(statsId)],
      ["LRANGE", listKey(statsId), 0, KEPT - 1],
    ]);
    if (typeof cached === "string") {
      const read = JSON.parse(cached) as RecentSale[];
      return Array.isArray(read) ? read.filter((s) => s && typeof s.product === "string" && typeof s.title === "string" && typeof s.country === "string" && Number.isSafeInteger(s.at) && s.at > 0 && s.at * 1000 >= now - RECENT_DAYS * 86_400_000 && s.at * 1000 <= now && store.catalog.items.some(item => item.id === s.product && (item.kind & KIND.hidden) === 0)).slice(0, SHOWN) : [];
    }
    const since = Math.floor(now / 1000) - RECENT_DAYS * 86_400;
    const kept = (Array.isArray(list) ? list : []).map(parseKept).filter((k): k is Kept => k !== null && Number.isSafeInteger(k.at) && k.at >= since && k.at <= Math.floor(now / 1000));
    let shown: RecentSale[] = [];
    if (kept.length) {
      const refunded = await refundedSince(store.stripeAccountId, Math.min(...kept.map((k) => k.at)));
      // Not cached: the next visit asks again rather than showing nothing for five minutes.
      if (!refunded) return [];
      const listings = new Map((await readListings(store, [...new Set(kept.map((k) => k.p))])).map((p) => [p.id, p]));
      shown = kept
        .filter((k) => !refunded.has(k.pi))
        .flatMap((k) => {
          const product = listings.get(k.p);
          return product && !product.hidden ? [{ product: product.id, title: product.title, at: k.at, country: k.c }] : [];
        })
        .slice(0, SHOWN);
    }
    await redisPipeline([["SET", feedKey(statsId), JSON.stringify(shown), "EX", FEED_SECONDS]]);
    return shown;
  } catch (error) {
    console.error("reading recent purchases failed", error);
    return [];
  }
}

/** Everything kept here for a store that is being deleted. */
export async function forgetRecentSales(statsId: string | null): Promise<void> {
  if (!statsId || !isRedisConfigured()) return;
  await redisPipeline([["DEL", listKey(statsId), feedKey(statsId)]]);
}
