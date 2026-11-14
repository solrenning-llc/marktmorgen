/**
 * A sale across the store: a percentage off, from one moment to another,
 * shown on every product it covers with the old price crossed out, and taken
 * off on Stripe's page with no code to type.
 *
 * Measured before it was built (30 September 2026): Stan has discount codes
 * with an expiry date, on its $99 plan (help.stan.store, article 43), which
 * the buyer has to know and type; no price crossed out on the store and no
 * sale that starts and ends by itself.
 *
 * What makes it honest:
 *
 *   - the end is real. After it, the store shows the normal price and the
 *     coupon behind the sale no longer works, because Stripe itself refuses
 *     it after the end (redeem_by), so nobody is told "ends Friday" of a sale
 *     that quietly goes on;
 *   - the price shown is Stripe's arithmetic: a percentage off each line,
 *     rounded to the cent the way Stripe rounds it;
 *   - it covers what can be bought once at one price: a download, a link, a
 *     course, a bundle. Not a membership, whose later payments would be at
 *     the full price, not a call, not a product with price options, not one
 *     where the buyer names the price, and not a payment plan, which is said
 *     on the page ("sale price when paid in full").
 *
 * Kept on the store record; the coupon is made on the creator's own Stripe
 * account when the sale is saved.
 */

export type StoreSale = {
  /** What the store calls it: "Black Friday". */
  name: string;
  /** Off every product it covers; 0 is no sale. */
  percent: number;
  /** In seconds. */
  starts: number;
  ends: number;
  /** Every product it can cover, or only those listed. */
  all: boolean;
  products: string[];
  /** The Stripe coupon on the creator's account that takes it off. */
  coupon: string;
  /**
   * The smallest amount the store's currency charges (lib/money.ts, minCharge), set when the store is read
   * (lib/store.ts), never kept: a product the sale would take below it is not on sale (DISC-S-1).
   */
  floorCents?: number;
};

export const NO_SALE: StoreSale = { name: "", percent: 0, starts: 0, ends: 0, all: true, products: [], coupon: "" };
export const SALE_PERCENTS = [5, 10, 15, 20, 25, 30, 35, 40, 50, 60, 70] as const;
export const MAX_SALE_NAME = 40;
export const MAX_SALE_DAYS = 31;
export const MAX_SALE_PRODUCTS = 200;
const PRODUCT_ID = /^[A-Za-z0-9_-]{1,64}$/;
const COUPON = /^[A-Za-z0-9_-]{3,64}$/;

export function parseSale(raw: unknown): StoreSale {
  if (!raw || typeof raw !== "object") return { ...NO_SALE };
  const v = raw as Record<string, unknown>;
  const percent = Number(v.percent);
  const starts = Number(v.starts);
  const ends = Number(v.ends);
  const coupon = typeof v.coupon === "string" && COUPON.test(v.coupon) ? v.coupon : "";
  if (!(SALE_PERCENTS as readonly number[]).includes(percent) || !coupon || !(ends > starts) || !(starts > 0)) {
    return { ...NO_SALE, name: typeof v.name === "string" ? v.name.slice(0, MAX_SALE_NAME) : "" };
  }
  return {
    name: typeof v.name === "string" ? v.name.replace(/\s+/g, " ").trim().slice(0, MAX_SALE_NAME) : "",
    percent,
    starts: Math.floor(starts),
    ends: Math.floor(ends),
    all: v.all !== false,
    products: Array.isArray(v.products)
      ? v.products.filter((p): p is string => typeof p === "string" && PRODUCT_ID.test(p)).slice(0, MAX_SALE_PRODUCTS)
      : [],
    coupon,
  };
}

/** The minimal facts about a product that decide whether a sale covers it. */
export type SaleCandidate = {
  id: string;
  priceCents: number;
  recurring: unknown;
  call: unknown;
  pwyw: unknown;
  options: unknown[];
};

/** Whether a product can ever be on sale: bought once, at one price, that the store sets. */
export function saleable(product: SaleCandidate): boolean {
  return product.priceCents > 0 && !product.recurring && !product.call && !product.pwyw && product.options.length === 0;
}

/** Whether the sale is running at this moment. */
export function saleRunning(sale: StoreSale, nowSeconds: number): boolean {
  return sale.percent > 0 && Boolean(sale.coupon) && sale.starts <= nowSeconds && nowSeconds < sale.ends;
}

/** The percentage off this product now, or 0. */
export function saleOff(sale: StoreSale, product: SaleCandidate, nowSeconds: number): number {
  if (!saleRunning(sale, nowSeconds) || !saleable(product)) return 0;
  if (!sale.all && !sale.products.includes(product.id)) return 0;
  // Never below what the currency can be charged: the page, the checkout and the cart all read this (DISC-S-1).
  if (sale.floorCents !== undefined && salePrice(product.priceCents, sale.percent) < sale.floorCents) return 0;
  return sale.percent;
}

/** A price with a percentage off, rounded to the cent as Stripe rounds a coupon's discount. */
export function salePrice(cents: number, percent: number): number {
  if (percent <= 0) return cents;
  return cents - Math.round((cents * percent) / 100);
}

/** "Ends in 2 days", "Ends in 5 hours", "Ends in 12 minutes". */
export function endsWords(ends: number, nowSeconds: number): string {
  const left = Math.max(0, ends - nowSeconds);
  const days = Math.floor(left / 86_400);
  const hours = Math.floor(left / 3_600);
  const minutes = Math.max(1, Math.ceil(left / 60));
  if (days >= 2) return `Ends in ${days} days`;
  if (hours >= 2) return `Ends in ${hours} hours`;
  if (hours === 1) return "Ends in 1 hour";
  return `Ends in ${minutes} ${minutes === 1 ? "minute" : "minutes"}`;
}

/** Now, in seconds, for the pages that show a sale. */
export function saleClock(): number {
  return Math.floor(Date.now() / 1000);
}

/** A sale that ran before the one set now, kept for the marks on the numbers (lib/auto-marks.ts). */
export type PastSale = { name: string; percent: number; starts: number; ends: number };
export const MAX_PAST_SALES = 20;

export function parsePastSales(raw: unknown): PastSale[] {
  if (!Array.isArray(raw)) return [];
  const out: PastSale[] = [];
  for (const item of raw) {
    if (!item || typeof item !== "object") continue;
    const v = item as Record<string, unknown>;
    const percent = Number(v.percent);
    const starts = Math.floor(Number(v.starts));
    const ends = Math.floor(Number(v.ends));
    if (!(percent > 0 && percent < 100) || !(starts > 0) || !(ends > starts)) continue;
    out.push({ name: typeof v.name === "string" ? v.name.replace(/\s+/g, " ").trim().slice(0, MAX_SALE_NAME) : "", percent, starts, ends });
  }
  return out.slice(-MAX_PAST_SALES);
}

/** The past sales once `next` replaces `current` at `now` (seconds): the one replaced is kept if it had begun. Pure. */
export function withPastSale(past: PastSale[], current: StoreSale, next: StoreSale, now: number): PastSale[] {
  if (!(current.percent > 0) || current.starts > now || (next.starts === current.starts && next.percent === current.percent)) return past;
  const ended = { name: current.name, percent: current.percent, starts: current.starts, ends: Math.min(current.ends, now) };
  if (!(ended.ends > ended.starts)) return past;
  return [...past.filter((p) => p.starts !== ended.starts), ended].slice(-MAX_PAST_SALES);
}
