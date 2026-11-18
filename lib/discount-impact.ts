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
 *
 * Money in two currencies does not add up, so the table holds the store's
 * own currency only, and sales paid in another one are totalled per
 * currency beside it (discountElsewhere, 22 [E5] unit 2), each in its own
 * money and never converted: a buyer who pays in euros on purpose, once
 * buyers may (docs/buyer-currency-and-language.md), is said, not dropped.
 */
import { CODE_PATTERN } from "@/lib/discount-rules";
import { formatMoney } from "@/lib/money";

/** Which discount a sale had, as the checkout wrote it (lib/store-checkout.ts). */
export type DiscountKind = "full" | "code" | "sale" | "fair" | "member" | "intro" | "comeback" | "welcome";
export const DISCOUNT_KINDS: DiscountKind[] = ["full", "code", "sale", "fair", "member", "intro", "comeback", "welcome"];

export const DISCOUNT_NAMES: Record<DiscountKind, string> = {
  full: "Full price",
  code: "Discount code",
  sale: "Store sale",
  fair: "Fair price by country",
  member: "Member price",
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
  if (meta.member) return "member";
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

/**
 * One discount code's sales over the same days (760 [STN7], unit 2), so the
 * creator sees which code sold, not only that codes did. `group` is "code"
 * for a code the checkout named; "others" adds up the codes past
 * CODE_ROWS_MAX; "typed" holds the codes a buyer typed in Stripe's own box,
 * which the checkout cannot name (Stripe says only that a discount came off),
 * so they are one row and never guessed. `code` is null except for "code".
 */
export type DiscountCodeRow = {
  code: string | null;
  group: "code" | "others" | "typed";
  sales: number;
  /** Paid, after the code. */
  cents: number;
  /** What the code took off. */
  off: number;
  /** Of these sales, how many were refunded (in full or in part). */
  refunded: number;
};

/**
 * The most codes listed one by one; the rest are added into one row, so the
 * table stays short whatever the store had over the 90 days (a store keeps
 * at most twenty live codes, lib/discount-rules.ts, but codes since removed
 * still have their sales).
 */
export const CODE_ROWS_MAX = 20;

/**
 * The code a checkout's own note names, upper case as Stripe compares codes:
 * a code from a link (`code`, also a call's code taken off before Stripe's
 * page) or a code for returning buyers (`returning`). Null when none is
 * named, or when the note is not a code as lib/discount-rules.ts allows one,
 * so nothing else is ever shown as a code. Pure.
 */
export function codeOf(row: Record<string, unknown>): string | null {
  const meta = (row.metadata ?? {}) as Record<string, unknown>;
  for (const value of [meta.code, meta.returning]) {
    if (typeof value !== "string") continue;
    const code = value.trim().toUpperCase();
    if (CODE_PATTERN.test(code)) return code;
  }
  return null;
}

/**
 * Sales by code: the checkouts the table by kind counts as "Discount code"
 * (the same days, the store's currency, no one-click extras or tips), each
 * under the code it named, most sales first, then more revenue, then the
 * code's letters; past CODE_ROWS_MAX codes the rest are added into one
 * "others" row, and codes typed in Stripe's box come last as one "typed"
 * row. The rows add up to that "Discount code" row. Empty when no sale had
 * a code. Worked out from the sales already read: nothing more is asked of
 * Stripe. Pure.
 */
export function discountCodes(sales: DiscountSale[], refunded: Set<string>, currency: string, now: number, days = 90): DiscountCodeRow[] {
  const since = now - days * 86_400_000;
  const named = new Map<string, DiscountCodeRow>();
  const typed: DiscountCodeRow = { code: null, group: "typed", sales: 0, cents: 0, off: 0, refunded: 0 };
  for (const sale of sales) {
    if (sale.upsell || sale.currency !== currency) continue;
    if (sale.created < since || sale.created > now) continue;
    const meta = (sale.row.metadata ?? {}) as Record<string, string>;
    if (meta.kind === "tip" || discountKindOf(sale.row) !== "code") continue;
    const code = codeOf(sale.row);
    const row = code === null ? typed : named.get(code) ?? { code, group: "code" as const, sales: 0, cents: 0, off: 0, refunded: 0 };
    row.sales += 1;
    row.cents += sale.cents;
    row.off += discountOff(sale.row);
    if (sale.paymentIntent && refunded.has(sale.paymentIntent)) row.refunded += 1;
    if (code !== null) named.set(code, row);
  }
  const ranked = [...named.values()].sort((a, b) => b.sales - a.sales || b.cents - a.cents || ((a.code as string) < (b.code as string) ? -1 : 1));
  const rows = ranked.slice(0, CODE_ROWS_MAX);
  const rest = ranked.slice(CODE_ROWS_MAX);
  if (rest.length) {
    const others: DiscountCodeRow = { code: null, group: "others", sales: 0, cents: 0, off: 0, refunded: 0 };
    for (const row of rest) {
      others.sales += row.sales;
      others.cents += row.cents;
      others.off += row.off;
      others.refunded += row.refunded;
    }
    rows.push(others);
  }
  if (typed.sales) rows.push(typed);
  return rows;
}

/** The checkouts of one other currency over the same days, counted apart from the table. */
export type DiscountElsewhere = {
  currency: string;
  sales: number;
  /** Paid, after the discount, in that currency. */
  cents: number;
  /** Of these sales, how many had a discount. */
  discounted: number;
  /** What the discounts took off, in that currency. */
  off: number;
};

/** A currency code as Stripe writes one: three lowercase letters. Anything else is not counted anywhere. */
const CODE = /^[a-z]{3}$/;

/**
 * The checkouts the table leaves out because they were paid in another
 * currency, totalled per currency in code order: the same days, the same
 * checkouts (no one-click extras, no tips), each amount in its own currency
 * and never converted. Pure.
 */
export function discountElsewhere(sales: DiscountSale[], currency: string, now: number, days = 90): DiscountElsewhere[] {
  const since = now - days * 86_400_000;
  const by = new Map<string, DiscountElsewhere>();
  for (const sale of sales) {
    if (sale.upsell || sale.currency === currency || !CODE.test(sale.currency)) continue;
    if (sale.created < since || sale.created > now) continue;
    const meta = (sale.row.metadata ?? {}) as Record<string, string>;
    if (meta.kind === "tip") continue;
    const row = by.get(sale.currency) ?? { currency: sale.currency, sales: 0, cents: 0, discounted: 0, off: 0 };
    row.sales += 1;
    row.cents += sale.cents;
    if (discountKindOf(sale.row) !== "full") {
      row.discounted += 1;
      row.off += discountOff(sale.row);
    }
    by.set(sale.currency, row);
  }
  return [...by.values()].sort((a, b) => (a.currency < b.currency ? -1 : a.currency > b.currency ? 1 : 0));
}

/** The sentence under the table for sales in another currency, each in its own money; null when there are none. Pure. */
export function elsewhereWords(rows: DiscountElsewhere[]): string | null {
  if (rows.length === 0) return null;
  const parts = rows.map((row) => {
    const money = (cents: number) => formatMoney(cents, row.currency);
    const sold = `${money(row.cents)} from ${row.sales.toLocaleString("en-US")} ${row.sales === 1 ? "sale" : "sales"}`;
    return row.discounted > 0 ? `${sold}, ${row.discounted.toLocaleString("en-US")} with a discount taking ${money(row.off)} off` : sold;
  });
  return `Sales paid in another currency are not added to the table, because amounts in two currencies do not add up: ${parts.join("; ")}.`;
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
