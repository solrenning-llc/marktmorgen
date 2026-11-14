import { bumpsFromMeta, bundleFromMeta } from "@/lib/bundle-rules";
import { formatMoney } from "@/lib/money";

/**
 * How much each sales lever on "Grow your sales" earned in the last 30 days
 * (752 [CD3] part (b)), summed from the paid records the studio's kept sales
 * reading already holds (lib/stats.ts readSales, kept by lib/store-readings.ts).
 * Pure: no read, no write, no provider call. Gross, as charged: before refunds,
 * fees, taxes and other costs, as the screen says.
 *
 * What today's records let each lever be recognized by:
 *   - Order bump: a paid Checkout Session's `bump`/`bump2`/`bump3` metadata
 *     with its `<key>_cents` (lib/store-checkout.ts), on a session with no
 *     discount (total_details.amount_discount exactly 0). A percent coupon or
 *     a typed code takes part of the bump's line off, and that share is not
 *     recorded, so such an order is "left", never estimated.
 *   - Upsell: a succeeded PaymentIntent with metadata kind=upsell
 *     (lib/upsell.ts), at its own amount. A downsell is paid the same way and
 *     its payment does not say it followed a "No", so it is counted here.
 *   - Bundle: a paid Checkout Session whose own product is a bundle
 *     (metadata `bundle`), at its whole amount_total (tax and any order bump on
 *     the same order included).
 *   - Downsell, checkout recovery, next offer: not recognizable. The reminder
 *     (lib/checkout-recovery.ts) and the next offer (components/next-offer-card.tsx)
 *     link to the product page, and the order placed from there carries no
 *     mark of either; Stripe's `recovered_from` is its own recovery address,
 *     which Marktmorgen never sends, so it is not this lever's sale.
 *
 * Rule 24: a date, currency or amount Stripe's record does not give is never
 * taken from the fallbacks lib/stats.ts uses ("now", 0): an undated or
 * currency-less record makes the reading incomplete, a tagged one without an
 * exact amount is counted as "left". Each currency is summed on its own and
 * never added to another.
 */

export type LeverKey = "bump" | "upsell" | "downsell" | "bundle" | "recovery" | "next";
export type PaidRecord = { created: number; cents: number; currency: string; upsell: boolean; row: Record<string, unknown> };
export type LeverAmount = { currency: string; cents: number; orders: number };
/** Measured: the store's currency first (present even at 0), each other currency apart. `left` counts tagged orders whose exact amount is not in the record. */
export type LeverEarned = { measured: true; amounts: LeverAmount[]; left: number } | { measured: false };
/** The row a reading kept before this count (no `measured`): shown as not measured, never as its old figure. */
export type KeptLeverMeasure = { records: number; cents: number | null; scope: string };
export type LeverReading = { asOf: string; from: string; currency: string; complete: boolean; rows: Record<LeverKey, LeverEarned | KeptLeverMeasure> };

export const LEVER_DAYS = 30;
/** Currencies kept per lever, the store's own included; orders in any further currency are counted as left. */
export const LEVER_CURRENCIES_MAX = 4;

const CODE = /^[a-z]{3}$/;
const exact = (value: unknown): value is number => typeof value === "number" && Number.isSafeInteger(value) && value >= 0;

export function leverEarnings(sales: readonly PaidRecord[], currency: string, partial: boolean, now = Date.now()): LeverReading {
  const end = new Date(now);
  const from = new Date(Date.UTC(end.getUTCFullYear(), end.getUTCMonth(), end.getUTCDate()) - (LEVER_DAYS - 1) * 86_400_000);
  const own = currency.toLowerCase();
  let complete = !partial;
  const bucket = () => ({ amounts: [{ currency: own, cents: 0, orders: 0 }] as LeverAmount[], left: 0 });
  const sums = { bump: bucket(), upsell: bucket(), bundle: bucket() };
  const add = (key: keyof typeof sums, code: string, cents: number | null) => {
    const lever = sums[key];
    if (cents === null) {
      lever.left += 1;
      return;
    }
    let row = lever.amounts.find((amount) => amount.currency === code);
    if (!row) {
      if (lever.amounts.length >= LEVER_CURRENCIES_MAX) {
        lever.left += 1;
        return;
      }
      row = { currency: code, cents: 0, orders: 0 };
      lever.amounts.push(row);
    }
    if (!Number.isSafeInteger(row.cents + cents)) {
      lever.left += 1;
      return;
    }
    row.cents += cents;
    row.orders += 1;
  };

  for (const sale of sales) {
    const row = sale.row ?? {};
    const created = typeof row.created === "number" && Number.isFinite(row.created) ? row.created * 1000 : null;
    const code = typeof row.currency === "string" ? row.currency.toLowerCase() : "";
    if (created === null || !CODE.test(code)) {
      complete = false;
      continue;
    }
    if (created < from.getTime() || created > now) continue;
    const meta = row.metadata && typeof row.metadata === "object" && !Array.isArray(row.metadata) ? (row.metadata as Record<string, string>) : {};
    if (sale.upsell) {
      add("upsell", code, exact(row.amount) ? row.amount : null);
      continue;
    }
    const total = exact(row.amount_total) ? row.amount_total : null;
    const bumps = bumpsFromMeta(meta);
    if (bumps.length) {
      const discount = (row.total_details as { amount_discount?: unknown } | null | undefined)?.amount_discount;
      let cents: number | null = discount === 0 && total !== null ? 0 : null;
      for (const bump of bumps) {
        if (cents === null) break;
        const text = meta[`${bump.key}_cents`];
        const price = typeof text === "string" && /^\d{1,12}$/.test(text) ? Number(text) : null;
        cents = price === null ? null : cents + price;
      }
      add("bump", code, cents !== null && total !== null && cents <= total ? cents : null);
    }
    if (bundleFromMeta(meta, "bundle").length) add("bundle", code, total);
  }

  return {
    asOf: end.toISOString(),
    from: from.toISOString(),
    currency: own,
    complete,
    rows: {
      bump: { measured: true, ...sums.bump },
      upsell: { measured: true, ...sums.upsell },
      downsell: { measured: false },
      bundle: { measured: true, ...sums.bundle },
      recovery: { measured: false },
      next: { measured: false },
    },
  };
}

const HOW: Record<LeverKey, string> = {
  bump: "Counted from each order bump's own price on paid checkouts, before tax. An order with a discount is not counted, because the bump's discounted share is not recorded.",
  upsell: "Counted from each one-click offer paid after checkout, as charged. Downsells are paid the same way and are included here.",
  downsell: "A downsell is paid like an upsell and its payment does not say it followed a No, so it is counted under Upsell.",
  bundle: "Counted from each whole paid order for a bundle, as charged, including tax and any order bump on the same order.",
  recovery: "A reminder links to your product page, and the order placed from there is not tagged, so it cannot be told apart from other orders.",
  next: "The next offer links to your product page, and the order placed from there is not tagged, so it cannot be told apart from other orders.",
};

/** One kept amount, exactly: a currency code and non-negative whole cents and orders. */
function exactAmount(value: unknown): value is LeverAmount {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const amount = value as Record<string, unknown>;
  return typeof amount.currency === "string" && CODE.test(amount.currency) && exact(amount.cents) && exact(amount.orders);
}

const orders = (count: number) => `${count} ${count === 1 ? "order" : "orders"}`;

/** The card's two sentences: what the lever earned (or "Not measured yet.") and how it is counted, from its row and whether its reading is complete. Pure. */
export function leverEarnedWords(row: LeverEarned | KeptLeverMeasure | undefined, key: LeverKey, complete: boolean): { line: string; how: string } {
  if (!row || !("measured" in row)) {
    return { line: "Not measured yet.", how: row ? "Counted from your next payment reading." : "No payment reading is available." };
  }
  const how = HOW[key];
  if (!row.measured) return { line: "Not measured yet.", how };
  // A kept row is read back from storage: unless every amount (a currency code, exact non-negative cents and
  // orders) and the count left are exact, it is not shown as a figure (rule 24, review of #3582).
  const amounts: unknown = row.amounts;
  if (!Array.isArray(amounts) || !amounts.length || !amounts.every(exactAmount) || !exact(row.left)) return { line: "Not measured yet.", how };
  const [first, ...others] = amounts as LeverAmount[];
  const atLeast = !complete || row.left > 0 ? "at least " : "";
  let line = `Earned in the last 30 days: ${atLeast}${formatMoney(first.cents, first.currency)} from ${orders(first.orders)}`;
  if (row.left > 0) line += `; ${row.left === 1 ? "1 more order is" : `${row.left} more orders are`} not counted, because ${row.left === 1 ? "its" : "their"} exact amount is not in the payment record`;
  line += ".";
  if (others.length) {
    const parts = others.map((amount) => `${formatMoney(amount.cents, amount.currency)} from ${orders(amount.orders)} in ${amount.currency.toUpperCase()}`);
    line += ` Also ${parts.length > 1 ? `${parts.slice(0, -1).join(", ")} and ${parts[parts.length - 1]}` : parts[0]}, not added together.`;
  }
  return { line, how: complete ? how : `${how} The payment reading is incomplete.` };
}
