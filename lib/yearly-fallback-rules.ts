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
 *     already paid (even in part), voided or of another subscription, and
 *     still retried by itself (never one whose retries were stopped);
 *   - the membership pays once a year, one item of one, in the store's
 *     currency, charged automatically (never sent as an invoice to pay by
 *     hand), past due on that renewal (not canceled, not set to end, not
 *     paused), not driven by a subscription schedule, with no discount (on
 *     the subscription or on its item) and no affiliate share still running
 *     for a set number of months (yearly-switch-rules' own reasons, read the
 *     same way), and paid with a method that can carry a change made only if
 *     paid (PENDING_UPDATE_METHODS: never a bank debit, never unknown);
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
import { type YearlySub, affiliateMonthsLeft, discounted, discountsListed } from "@/lib/yearly-switch-rules";

/** The parts of a Stripe subscription these rules read: yearly-switch-rules' own, how it is collected and with what. */
export type FallbackSub = Omit<YearlySub, "items"> & {
  collection_method?: unknown;
  /** Set when a subscription schedule drives it (the creator's dashboard): a phase change voids a pending update. */
  schedule?: unknown;
  items?: {
    data?: {
      quantity?: unknown;
      /** A discount on the item itself, which `discounted` (the subscription's own) does not see; read by `discountsListed`. */
      discounts?: unknown;
      price?: { unit_amount?: unknown; currency?: unknown; recurring?: { interval?: unknown; interval_count?: unknown } | null } | null;
    }[];
  } | null;
  /** The membership's own payment method, expanded (`expand[]=default_payment_method`). */
  default_payment_method?: unknown;
  /**
   * An older source on the membership itself (a card or a bank account added before payment methods): Stripe charges
   * it before the customer's default, and its kind is not read here, so a membership with one is never offered.
   */
  default_source?: unknown;
  /** Its customer, expanded with the customer's default (`expand[]=customer.invoice_settings.default_payment_method`). */
  customer?: unknown;
};

/**
 * Payment methods whose payments can carry a change made only if paid (Stripe, Pending updates, "Before you begin",
 * docs.stripe.com/billing/subscriptions/pending-updates, read 4 November 2026). Bank debits (SEPA Direct Debit, ACH,
 * Bacs, BECS) are not among them: a move paid with one would apply before its money is known, so none is offered.
 * Apple Pay and Google Pay are cards to Stripe.
 */
export const PENDING_UPDATE_METHODS: ReadonlySet<string> = new Set([
  "card", "link", "alipay", "amazon_pay", "afterpay_clearpay", "cashapp", "eps", "kakao_pay", "klarna", "kr_card", "naver_pay",
  "paypal", "payto", "pix", "promptpay", "revolut_pay", "satispay", "swish", "twint", "wechat_pay",
]);

const typeOf = (method: unknown) => (method && typeof method === "object" ? (method as { type?: unknown }).type : undefined);

/**
 * The type of the payment method the month would be charged to: the membership's own, else its customer's default
 * (Stripe's order for a subscription's invoices), read only from expanded objects; null when it cannot be read.
 */
export function payingMethodType(sub: FallbackSub): string | null {
  if (sub.default_payment_method) {
    const own = typeOf(sub.default_payment_method);
    return typeof own === "string" ? own : null;
  }
  // Stripe's next in line is the membership's own older source, which can be a bank debit: never read as a card.
  if (sub.default_source) return null;
  const settings = sub.customer && typeof sub.customer === "object" ? (sub.customer as { invoice_settings?: { default_payment_method?: unknown } | null }).invoice_settings : null;
  const theirs = typeOf(settings?.default_payment_method);
  return typeof theirs === "string" ? theirs : null;
}

/** The parts of a Stripe invoice these rules read. */
export type FallbackInvoice = {
  /** Part paid already: such an invoice is never offered, its part could not be kept by a void. */
  amount_paid?: unknown;
  /** False when its retries were stopped (by the creator, or by Stripe at the end of its retries): never offered. */
  auto_advance?: unknown;
  /** Where the API versions since 2025 name the invoice's subscription. */
  parent?: { subscription_details?: { subscription?: unknown } | null } | null;
  /** Where older API versions name it. */
  subscription?: unknown;
  billing_reason?: unknown;
  status?: unknown;
  amount_due?: unknown;
  currency?: unknown;
  /** Discounts on the invoice itself (a customer's coupon lands here): any one means the price compared is not paid. */
  discounts?: unknown;
  total_discount_amounts?: unknown;
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

/** A discount on the expanded customer (`customer.discount`), or one that cannot be read: an unexpanded customer has none here. */
function customerDiscounted(customer: unknown): boolean {
  if (!customer || typeof customer !== "object") return false;
  const discount = (customer as { discount?: unknown }).discount;
  return discount !== undefined && discount !== null;
}

/** Any discount the invoice carries, in either of the two places Stripe lists them. */
function invoiceDiscounted(invoice: FallbackInvoice): boolean {
  const listed = (value: unknown) => Array.isArray(value) && value.some((entry) => entry !== null && entry !== undefined);
  if (listed(invoice.discounts)) return true;
  const amounts = invoice.total_discount_amounts;
  return Array.isArray(amounts) && amounts.some((entry) => typeof entry === "object" && entry !== null && num((entry as { amount?: unknown }).amount) !== 0);
}

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
  // Paid with a method that can carry a change made only if paid; unknown is never offered.
  const method = payingMethodType(sub);
  if (!method || !PENDING_UPDATE_METHODS.has(method)) return null;
  if (num(sub.cancel_at) > 0 || sub.cancel_at_period_end === true) return null;
  if (sub.pause_collection && typeof sub.pause_collection === "object") return null;
  const meta = sub.metadata ?? {};
  if (meta.ends_after || meta.kind === "plan") return null;
  if (discounted(sub as YearlySub)) return null;
  // Nor on the customer, nor on the invoice: a coupon there lowers what is charged, and the email would quote the
  // undiscounted price for both the month and the year.
  if (customerDiscounted(sub.customer) || invoiceDiscounted(invoice)) return null;
  // Not driven by a schedule: its next phase would put the year back, and a phase change voids a pending update.
  if (sub.schedule) return null;
  if (affiliateMonthsLeft(meta, nowSeconds)) return null;
  // Once a year, one item of one, in the store's currency.
  const items = sub.items?.data ?? [];
  if (items.length !== 1) return null;
  const item = items[0];
  if ((item.quantity ?? 1) !== 1) return null;
  // No discount on the item either: the yearly figure compared would be the undiscounted price. Read at
  // FALLBACK_STRIPE_VERSION, where every item lists its discounts: one not read as an empty list is not known, never none.
  if (discountsListed(item.discounts) !== false) return null;
  const price = item.price;
  if (!price?.recurring || price.recurring.interval !== "year" || (price.recurring.interval_count ?? 1) !== 1) return null;
  if (String(price.currency ?? "").toLowerCase() !== storeCurrency.toLowerCase()) return null;
  // Still owed, and compared on one footing: the membership's own yearly price, before tax and credit.
  if (num(invoice.amount_due) <= 0) return null;
  // Nothing paid on it yet, and still retried by itself: an invoice partly paid could not be voided whole, and one
  // whose retries were stopped is not this offer's to turn back on.
  if (invoice.amount_paid !== undefined && invoice.amount_paid !== 0) return null;
  if (invoice.auto_advance === false) return null;
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
