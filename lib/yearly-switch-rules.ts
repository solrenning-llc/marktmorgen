/**
 * A member who pays monthly moving to the same membership's yearly price
 * (added 12 October 2026), as rules the browser can read too. The switch is
 * in lib/yearly-switch.ts; the one email that offers it in lib/yearly-ask.ts.
 *
 * Read before it was built: Patreon, Kajabi, Skool and Memberful sell a
 * yearly price beside the monthly one, and Memberful and Chargebee let a
 * monthly member move to it from their own page, prorated. Until now a
 * member here could only choose yearly when buying.
 *
 * Offered only where it saves the member money and costs the creator
 * nothing they did not agree to:
 *
 *   - a monthly membership (once a month) running until canceled, paid up or
 *     in its trial, not paused, not set to end, one item of one;
 *   - the product still offers its yearly price (lib/yearly-price.ts), in the
 *     currency the member pays in, and that year costs less than twelve of
 *     the member's own monthly payments, so the saving said is theirs;
 *   - no discount on the membership: a coupon for a few months would
 *     otherwise come off a whole year's payment;
 *   - no affiliate share still running for a set number of months: a year
 *     paid at once inside those months would give the affiliate a share of
 *     all twelve. A share for as long as the member pays is the same either
 *     way, so it does not stop the offer.
 */
import { RECURRING_ALWAYS } from "@/lib/affiliate-setting";
import { type YearlyCandidate, type Yearly, activeYearly } from "@/lib/yearly-price";
import { inPaidFreeDays, realTrialEnd } from "@/lib/member-free-days-rules";

/** The parts of a Stripe subscription these rules read. */
export type YearlySub = {
  status?: unknown;
  start_date?: unknown;
  trial_end?: unknown;
  cancel_at?: unknown;
  cancel_at_period_end?: unknown;
  pause_collection?: unknown;
  discount?: unknown;
  discounts?: unknown;
  metadata?: Record<string, string> | null;
  items?: {
    data?: {
      quantity?: unknown;
      price?: { unit_amount?: unknown; currency?: unknown; recurring?: { interval?: unknown; interval_count?: unknown } | null } | null;
    }[];
  } | null;
};

export type YearlyChoice = {
  /** What one year costs, in the smallest unit of the store's currency. */
  cents: number;
  /** Twelve of the member's own monthly payments, less the year. */
  saving: number;
  /** One monthly payment now. */
  monthly: number;
};

const num = (value: unknown) => (typeof value === "number" && Number.isFinite(value) ? value : 0);

/** Whether an affiliate's share for a set number of months still runs on this membership. */
export function affiliateMonthsLeft(meta: Record<string, string> | null | undefined, nowSeconds: number): boolean {
  if (!meta?.via) return false;
  const months = Number(meta.via_months) || 0;
  if (months < 1 || months >= RECURRING_ALWAYS) return false;
  const at = Number(meta.via_at) || 0;
  if (!at) return true;
  const start = new Date(at * 1000);
  const end = Date.UTC(start.getUTCFullYear(), start.getUTCMonth() + months, start.getUTCDate(), start.getUTCHours(), start.getUTCMinutes(), start.getUTCSeconds()) / 1000;
  return nowSeconds < end;
}

/** Whether the membership carries a discount of any kind. */
export function discounted(sub: YearlySub): boolean {
  if (sub.discount && typeof sub.discount === "object") return true;
  return Array.isArray(sub.discounts) && sub.discounts.length > 0;
}

/**
 * The yearly price this membership can move to now, with what it saves, or
 * null. `product` is the product the membership is on now.
 */
export function yearlyChoice(
  sub: YearlySub,
  product: (YearlyCandidate & { yearly?: Yearly | null }) | null | undefined,
  tiers: readonly string[],
  storeCurrency: string,
  nowSeconds: number,
): YearlyChoice | null {
  if (!product) return null;
  const status = String(sub.status ?? "");
  if (status !== "active" && status !== "trialing") return null;
  // Paid, in free days given by the creator: Stripe prorates nothing in a trial, so it is offered again once they end.
  if (inPaidFreeDays(sub as Record<string, unknown>)) return null;
  if (num(sub.cancel_at) > 0 || sub.cancel_at_period_end === true) return null;
  if (sub.pause_collection && typeof sub.pause_collection === "object") return null;
  const meta = sub.metadata ?? {};
  if (meta.ends_after || meta.kind === "plan" || meta.every === "year") return null;
  if (discounted(sub)) return null;
  if (affiliateMonthsLeft(meta, nowSeconds)) return null;
  const items = sub.items?.data ?? [];
  if (items.length !== 1) return null;
  const item = items[0];
  if ((item.quantity ?? 1) !== 1) return null;
  const price = item.price;
  if (!price?.recurring || price.recurring.interval !== "month" || (price.recurring.interval_count ?? 1) !== 1) return null;
  if (String(price.currency ?? "").toLowerCase() !== storeCurrency.toLowerCase()) return null;
  const monthly = num(price.unit_amount);
  if (monthly <= 0) return null;
  const yearly = activeYearly(product, tiers);
  if (!yearly || yearly.cents >= monthly * 12) return null;
  return { cents: yearly.cents, saving: monthly * 12 - yearly.cents, monthly };
}

/** Days a member has paid monthly before the email offers yearly: from the third payment on. */
export const ASK_AFTER_DAYS = 58;

/**
 * Whether the email that offers yearly fits this membership now: paying (not
 * in a trial), from its third monthly payment on. Once per membership is
 * kept by lib/yearly-ask.ts.
 */
export function askFits(sub: YearlySub, nowSeconds: number): boolean {
  if (sub.status !== "active") return false;
  // From the real trial's end: free days given to a paid membership are not one (lib/member-free-days-rules.ts).
  const paidSince = Math.max(num(sub.start_date), realTrialEnd(sub as Record<string, unknown>));
  return paidSince > 0 && nowSeconds - paidSince >= ASK_AFTER_DAYS * 86_400;
}

/** The email offering yearly: on, and the postal address every list email carries. */
export type YearlyAsk = { on: boolean; address: string };
export const NO_YEARLY_ASK: YearlyAsk = { on: false, address: "" };

export function parseYearlyAsk(raw: unknown): YearlyAsk {
  const value = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
  const address = typeof value.address === "string" ? value.address.replace(/\s+/g, " ").trim().slice(0, 300) : "";
  return { on: value.on === true && address.length > 0, address };
}
