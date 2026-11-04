/**
 * How many times each product was bought, for a store that chose to say so
 * (StoreLook.sold, switched on under Look).
 *
 * Measured before it was built (7 October 2026): Gumroad shows "N sales" on a
 * product's page when the creator allows it, and Udemy, Teachable and Kajabi
 * course pages show a count of students. Stan's cards show none. A number a
 * buyer can trust moves a buyer; a number anybody could type moves them once
 * and then never again, which is why this one is never typed:
 *
 *   - It is read from the creator's own Stripe account (lib/stats.ts,
 *     readAllTimeSales): paid checkouts of this store and one-click extras,
 *     counted per product. Nothing is entered, adjusted or rounded up.
 *   - It is kept a few hours, so a busy page asks Stripe nothing, and read
 *     again in the background once older than that. A page with nothing
 *     kept yet shows no number rather than a guess, and asks for one.
 *   - It is only said once there are at least SHOWN_FROM, because "bought 2
 *     times" tells a visitor something the creator did not mean to say.
 *   - "Bought N times" is the claim, which is exactly what was counted: a
 *     sale later refunded was still bought, and nothing here says "students",
 *     "happy customers" or anything else the count does not measure.
 *
 *   nl:sold:<statsId>   {"at": ms, "p": {"<product>": sales}, "t": what buyers also bought (lib/also-bought.ts)}, for SOLD_KEEP_SECONDS
 */
import { isRedisConfigured, redisPipeline } from "@/lib/redis";
import type { Store } from "@/lib/store";
import { type Together, parseTogether } from "@/lib/also-bought";

/** Below this, nothing is said. */
export const SHOWN_FROM = 10;
/** How long a reading is used as it is before it is read again in the background. */
export const SOLD_FRESH_MS = 6 * 60 * 60 * 1000;
/** How long one store's reading holds the next one off: as long as its counts stay fresh. */
export const SOLD_LOCK_SECONDS = SOLD_FRESH_MS / 1000;
/** How long a reading is kept at all: a page never shows a count older than this. */
const SOLD_KEEP_SECONDS = 7 * 24 * 60 * 60;

const soldKey = (statsId: string) => `nl:sold:${statsId}`;
const lockKey = (statsId: string) => `nl:sold:lock:${statsId}`;

export type SoldCounts = { at: number; byProduct: Record<string, number>; together: Together };

/** The words a page shows, or null when there is nothing worth saying. */
export function soldWords(count: number | undefined): string | null {
  if (!count || count < SHOWN_FROM) return null;
  return `Bought ${count.toLocaleString("en-US")} times`;
}

/** What was kept for this store, or null; the caller decides whether it is fresh enough. */
export async function readSoldCounts(store: Store): Promise<SoldCounts | null> {
  if (!store.look.sold || !store.statsId || !isRedisConfigured()) return null;
  const [raw] = await redisPipeline([["GET", soldKey(store.statsId)]]);
  if (typeof raw !== "string" || !raw) return null;
  try {
    const value = JSON.parse(raw) as { at?: unknown; p?: unknown; t?: unknown };
    if (typeof value.at !== "number" || !value.p || typeof value.p !== "object") return null;
    const byProduct: Record<string, number> = {};
    for (const [id, n] of Object.entries(value.p as Record<string, unknown>)) {
      if (typeof n === "number" && Number.isInteger(n) && n > 0) byProduct[id] = n;
    }
    return { at: value.at, byProduct, together: parseTogether(value.t) };
  } catch {
    return null;
  }
}

/** Whether a reading should be taken again. */
export function stale(counts: SoldCounts | null, now = Date.now()): boolean {
  return counts === null || now - counts.at > SOLD_FRESH_MS;
}

/**
 * Reads the counts again from Stripe and keeps them. One store reads at most
 * once every SOLD_LOCK_SECONDS, whoever asks and whatever came of the last
 * reading; meant to run after a page has been sent
 * (next/server's after), never while a visitor waits.
 */
export async function refreshSoldCounts(
  store: Store,
  read: (store: Store) => Promise<{ byProduct: Record<string, { sales: number }>; together?: Together } | null>,
  now = Date.now(),
): Promise<SoldCounts | null> {
  if (!store.look.sold || !store.statsId || !store.stripeAccountId || !isRedisConfigured()) return null;
  // Held as long as counts stay fresh, whether the reading worked or not: at most one reading of every sale a store
  // each SOLD_FRESH_MS, the bound its cost is priced at (tests/plan-cost-registry.ts, SOLD_READ).
  const [mine] = await redisPipeline([["SET", lockKey(store.statsId), "1", "NX", "EX", SOLD_LOCK_SECONDS]]);
  if (mine !== "OK") return null;
  try {
    const all = await read(store);
    if (!all) return null;
    const p: Record<string, number> = {};
    for (const [id, row] of Object.entries(all.byProduct)) if (id && row.sales > 0) p[id] = row.sales;
    const t = parseTogether(all.together);
    await redisPipeline([["SET", soldKey(store.statsId), JSON.stringify({ at: now, p, t }), "EX", SOLD_KEEP_SECONDS]]);
    return { at: now, byProduct: p, together: t };
  } catch (error) {
    console.error("counting what each product sold failed", error);
    return null;
  }
}
