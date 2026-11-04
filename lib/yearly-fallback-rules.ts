/**
 * A yearly renewal that did not go through, offered at the same membership's
 * monthly price instead (630 [HN6](14); added 4 November 2026): the rules,
 * browser-safe. The email that offers it (lib/payment-recovery.ts) and the
 * switch itself are the next units; nothing here is sent or charged yet.
 *
 * The other way round from lib/yearly-switch-rules.ts, which moves a monthly
 * member to the year. A member whose whole year failed often only lacks the
 * year's amount at once; keeping them at one month's price keeps a member
 * the creator would otherwise lose at the end of Stripe's retries. Offered
 * only where it is honest and costs the creator nothing they did not agree
 * to:
 *
 *   - the failed invoice is this membership's own renewal (Stripe's
 *     `billing_reason` "subscription_cycle"), still open, never an invoice
 *     already paid, voided or of another subscription;
 *   - the membership pays once a year, one item of one, in the store's
 *     currency, charged automatically (never sent as an invoice to pay by
 *     hand), past due on that renewal (not canceled, not set to end, not
 *     paused), with no discount and no affiliate share still running for a
 *     set number of months (yearly-switch-rules' own reasons, read the same
 *     way);
 *   - the product still sells monthly with a yearly price beside it
 *     (lib/yearly-price.ts, activeYearly): the monthly price offered is the
 *     product's own today, never one typed for the offer;
 *   - and twelve of those months cost at least as much as the year that
 *     failed, which the email says plainly (`extraPerYear`), so nobody reads
 *     a monthly price as a saving.
 *
 * Switching charges the first month now and voids the failed yearly invoice,
 * so the member never owes both (the next unit, with its test).
 */
import { type Yearly, type YearlyCandidate, activeYearly } from "@/lib/yearly-price";
import { type YearlySub, affiliateMonthsLeft, discounted } from "@/lib/yearly-switch-rules";

/** The parts of a Stripe subscription these rules read: yearly-switch-rules' own, and how it is collected. */
export type FallbackSub = YearlySub & { collection_method?: unknown };

/** The parts of a Stripe invoice these rules read. */
export type FallbackInvoice = {
  /** Where the API versions since 2025 name the invoice's subscription. */
  parent?: { subscription_details?: { subscription?: unknown } | null } | null;
  /** Where older API versions name it. */
  subscription?: unknown;
  billing_reason?: unknown;
  status?: unknown;
  amount_due?: unknown;
  currency?: unknown;
};

/** What the member may move to, in the smallest unit of the store's currency. */
export type MonthlyFallback = {
  /** One month at the product's monthly price, charged now if they switch. */
  monthly: number;
  /**
   * The yearly price that did not go through, never charged if they switch: the membership's own price, before tax
   * and before any credit, so it is compared with the monthly price on the same footing (never the invoice's
   * amount due, which can carry tax on top or a credit taken off).
   */
  yearly: number;
  /** What twelve months cost more than the year: never negative, said in the email. */
  extraPerYear: number;
};

const num = (value: unknown) => (typeof value === "number" && Number.isFinite(value) ? value : 0);

/**
 * The monthly price this membership can keep going at after its yearly
 * renewal failed, or null. `subId` is the membership's own id; `product` the
 * product it is on now.
 */
export function monthlyFallback(
  subId: string,
  sub: FallbackSub,
  invoice: FallbackInvoice,
  product: (YearlyCandidate & { yearly?: Yearly | null }) | null | undefined,
  tiers: readonly string[],
  storeCurrency: string,
  nowSeconds: number,
): MonthlyFallback | null {
  if (!product || !subId) return null;
  // Its own renewal, still unpaid.
  const named = invoice.parent?.subscription_details?.subscription ?? invoice.subscription;
  const invoiceSub = typeof named === "string" ? named : null;
  if (invoiceSub !== subId) return null;
  if (invoice.billing_reason !== "subscription_cycle" || invoice.status !== "open") return null;
  if (String(invoice.currency ?? "").toLowerCase() !== storeCurrency.toLowerCase()) return null;
  // Past due on it: not canceled, not set to end, not paused. Charged automatically: the only kind a move made only if
  // paid can be (Stripe, Pending updates: "if the subscription's collection_method is charge_automatically").
  if (sub.status !== "past_due") return null;
  if (sub.collection_method !== "charge_automatically") return null;
  if (num(sub.cancel_at) > 0 || sub.cancel_at_period_end === true) return null;
  if (sub.pause_collection && typeof sub.pause_collection === "object") return null;
  const meta = sub.metadata ?? {};
  if (meta.ends_after || meta.kind === "plan") return null;
  if (discounted(sub)) return null;
  if (affiliateMonthsLeft(meta, nowSeconds)) return null;
  // Once a year, one item of one, in the store's currency.
  const items = sub.items?.data ?? [];
  if (items.length !== 1) return null;
  const item = items[0];
  if ((item.quantity ?? 1) !== 1) return null;
  const price = item.price;
  if (!price?.recurring || price.recurring.interval !== "year" || (price.recurring.interval_count ?? 1) !== 1) return null;
  if (String(price.currency ?? "").toLowerCase() !== storeCurrency.toLowerCase()) return null;
  // Still owed, and compared on one footing: the membership's own yearly price, before tax and credit.
  if (num(invoice.amount_due) <= 0) return null;
  const yearly = num(price.unit_amount);
  if (yearly <= 0) return null;
  // The product still sells monthly with a yearly price beside it: its own monthly price, today.
  if (!activeYearly(product, tiers)) return null;
  const monthly = product.priceCents;
  if (monthly <= 0 || monthly >= yearly) return null;
  // Never offered as a saving: twelve months cost at least the year.
  const extraPerYear = monthly * 12 - yearly;
  if (extraPerYear < 0) return null;
  return { monthly, yearly, extraPerYear };
}

/**
 * The lines the email adds below the link that pays the year, in plain US
 * English (the other languages come with the email unit): the monthly price,
 * that the year is then not charged, and what twelve months cost more. Every
 * amount is before tax; where the store adds tax on top (`taxOnTop`), each
 * says so, so no price reads lower than what is charged.
 */
export function fallbackLines(offer: MonthlyFallback, money: (cents: number) => string, taxOnTop: boolean): string[] {
  const plus = taxOnTop ? " plus tax" : "";
  const lines = [
    `If a whole year is too much now, you can stay a member at ${money(offer.monthly)}${plus} a month.`,
    `Then the yearly payment of ${money(offer.yearly)}${plus} is not charged.`,
  ];
  lines.push(
    offer.extraPerYear > 0 ? `Twelve months cost ${money(offer.extraPerYear)} more than the year${taxOnTop ? ", before tax" : ""}.` : "Twelve months cost the same as the year.",
  );
  return lines;
}
