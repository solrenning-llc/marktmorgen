/**
 * What discounts did (added 12 October 2026): sales at full price set beside
 * sales with each kind of discount, for the last 90 days — what was given
 * off, how many were refunded, and how many of those buyers bought again —
 * and, for memberships, how long members who joined with a discount stayed
 * beside those who paid in full (lib/membership-numbers.ts, staysBy).
 *
 * Read before it was built: Baremetrics' Revenue Pulse sets discounted
 * revenue beside the rest. Here it is worked out while the sales are read
 * (lib/stats.ts, readSales), from what Stripe already returns on each
 * checkout: the amount its discount took off, and the store's own note of
 * which discount it was. Nothing more is asked of Stripe. Rules the browser
 * can read too.
 */

/** Which discount a sale had, as the checkout wrote it (lib/store-checkout.ts). */
export type DiscountKind = "full" | "code" | "sale" | "fair" | "intro" | "comeback" | "welcome";
export const DISCOUNT_KINDS: DiscountKind[] = ["full", "code", "sale", "fair", "intro", "comeback", "welcome"];

export const DISCOUNT_NAMES: Record<DiscountKind, string> = {
  full: "Full price",
  code: "Discount code",
  sale: "Store sale",
  fair: "Fair price by country",
  intro: "Introductory price",
  comeback: "Come-back offer",
  welcome: "Welcome offer",
};

/** The parts of a sale this reads. */
export type DiscountSale = {
  created: number;
  cents: number;
  currency: string;
  upsell: boolean;
  paymentIntent: string;
  row: Record<string, unknown>;
};

export type DiscountRow = {
  kind: DiscountKind;
  sales: number;
  /** Paid, after the discount. */
  cents: number;
  /** What the discount took off. */
  off: number;
  /** Of these sales, how many were refunded (in full or in part). */
  refunded: number;
  /** Buyers among them, and how many of those bought something again afterward. */
  buyers: number;
  again: number;
};

const num = (value: unknown) => (typeof value === "number" && Number.isFinite(value) ? value : 0);

/** The discount kind of one checkout, from its own note of it and what Stripe took off. Pure. */
export function discountKindOf(row: Record<string, unknown>): DiscountKind {
  const meta = (row.metadata ?? {}) as Record<string, string>;
  const off = num((row.total_details as { amount_discount?: unknown } | null | undefined)?.amount_discount);
  if (meta.winback) return "comeback";
  if (meta.welcome) return "welcome";
  if (meta.intro) return "intro";
  if (meta.fair) return "fair";
  if (meta.sale) return "sale";
  return meta.code || off > 0 ? "code" : "full";
}

/** What a checkout's discount took off, in the smallest unit. Pure. */
export function discountOff(row: Record<string, unknown>): number {
  const off = num((row.total_details as { amount_discount?: unknown } | null | undefined)?.amount_discount);
  if (off > 0) return off;
  // A code on a booking with a deposit is taken off before Stripe's page (lib/deposit-code.ts): its note says how much.
  const noted = Number((row.metadata as Record<string, unknown> | null | undefined)?.code_off);
  return Number.isSafeInteger(noted) && noted > 0 ? noted : 0;
}

const emailOf = (row: Record<string, unknown>) => {
  const details = (row.customer_details ?? {}) as { email?: unknown };
  const email = typeof details.email === "string" ? details.email : typeof row.customer_email === "string" ? row.customer_email : "";
  return email.trim().toLowerCase();
};

/**
 * The table, from the sales read (newest first, as far back as they were
 * read) and the payments refunded. Only checkouts of the last `days` days in
 * the store's currency are grouped; a later sale of any kind to the same
 * address counts as buying again. Null when none of them had a discount, so
 * there is nothing to set beside full price. Pure.
 */
export function discountImpact(sales: DiscountSale[], refunded: Set<string>, currency: string, now: number, days = 90): DiscountRow[] | null {
  const since = now - days * 86_400_000;
  const by = new Map<DiscountKind, DiscountRow & { emails: Set<string>; againEmails: Set<string> }>();
  const checkouts = sales.filter((s) => !s.upsell && s.currency === currency);
  // Each address's purchases, oldest first, of every kind, to see who came back.
  const times = new Map<string, number[]>();
  for (const s of sales) {
    const email = emailOf(s.row);
    if (!email) continue;
    times.set(email, [...(times.get(email) ?? []), s.created]);
  }
  for (const sale of checkouts) {
    if (sale.created < since || sale.created > now) continue;
    const meta = (sale.row.metadata ?? {}) as Record<string, string>;
    if (meta.kind === "tip") continue;
    const kind = discountKindOf(sale.row);
    const row = by.get(kind) ?? { kind, sales: 0, cents: 0, off: 0, refunded: 0, buyers: 0, again: 0, emails: new Set<string>(), againEmails: new Set<string>() };
    row.sales += 1;
    row.cents += sale.cents;
    row.off += discountOff(sale.row);
    if (sale.paymentIntent && refunded.has(sale.paymentIntent)) row.refunded += 1;
    const email = emailOf(sale.row);
    if (email) {
      row.emails.add(email);
      // Another purchase more than an hour later: a box ticked at checkout or an offer taken right after is the same visit.
      if ((times.get(email) ?? []).some((t) => t > sale.created + 3_600_000)) row.againEmails.add(email);
    }
    by.set(kind, row);
  }
  const rows = DISCOUNT_KINDS.map((kind) => by.get(kind))
    .filter((row): row is NonNullable<typeof row> => Boolean(row))
    .map(({ emails, againEmails, ...row }) => ({ ...row, buyers: emails.size, again: againEmails.size }));
  return rows.some((row) => row.kind !== "full") ? rows : null;
}

/** How a membership began, from what its checkout wrote on it. Pure. */
export function entryOf(meta: Record<string, string> | null | undefined): DiscountKind {
  if (!meta) return "full";
  if (meta.winback) return "comeback";
  if (meta.welcome) return "welcome";
  if (meta.intro) return "intro";
  const d = meta.discount;
  return d === "code" || d === "sale" || d === "fair" || d === "welcome" ? d : "full";
}
