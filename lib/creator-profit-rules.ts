/**
 * The creator's own profit, before taxes (545 [LU1], unit 1; added
 * 1 November 2026): per order and per period, with where each number comes
 * from; per product and option (unit 2), the order's fee, refund and other
 * costs shared between its lines by each one's part of what was paid. Not Marktmorgen's own margin (lib/company-margin-report.ts), which
 * is another thing entirely.
 *
 *   paid      the order's payments, from the creator's own Stripe account
 *   refunded  what was given back, from the same place
 *   fee       Stripe's real fees on the order, net: the balance
 *             transactions of its charges, refunds and disputes added up,
 *             so a fee Stripe gives back or a dispute fee is counted as it
 *             was; read, never estimated
 *   cost      what the creator entered as their cost per sale; empty is
 *             "not set", never 0
 *   ads       ads the creator already recorded
 *
 * A cost not set makes that line "Incomplete: cost not set"; a fee or a
 * payment that could not be read makes it "Count unavailable". Neither is
 * ever counted as zero. Each currency stands on its own: nothing converted.
 * Always said: before taxes, and nothing about the creator's taxes.
 *
 * Reading the fees, keeping the costs, the panel and the export are the next
 * units. Browser-safe: plain data and pure functions.
 */
import { formatMoney, readMoney, type Currency } from "@/lib/money";
import { csvLine } from "@/lib/csv";

/** The sentence that always goes with the panel and the export. */
export const BEFORE_TAXES = "Before taxes. Marktmorgen does not know your taxes; check with your own tax rules.";

/** Where each number comes from, said beside it. */
export const SOURCES = { paid: "from your Stripe account", refunded: "from your Stripe account", fee: "from your Stripe account", cost: "you entered", ads: "recorded ads" } as const;

/** The most a cost per sale may be, in the smallest unit: a typing slip past it is refused, not kept. */
const MAX_COST = 100_000_000;

/** The creator's cost per sale as typed: an amount in the store's currency, or null when left empty ("not set"); undefined when it is not an amount. */
export function readCostPerSale(raw: string, currency: Currency): number | null | undefined {
  if (!raw.trim()) return null;
  const cents = readMoney(raw, currency);
  return cents === null || cents > MAX_COST ? undefined : cents;
}

export type OrderLine = { productId: string; units: number; costPerSale: number | null };
export type OrderMoney = {
  currency: string;
  paid: number | null;
  refunded: number | null;
  fee: number | null;
  lines: OrderLine[];
  /** Shipping labels and print on demand, once those exist: null when they could not be read. */
  otherCosts: number | null;
};

export type Profit = { state: "complete"; cents: number } | { state: "incomplete"; why: "cost not set" } | { state: "unavailable" };

const known = (n: number | null): n is number => n !== null && Number.isSafeInteger(n) && n >= 0;

/**
 * One order's profit before taxes. A refunded order keeps its cost: what
 * was made or sent is spent either way. A line that is not a whole number
 * of units, or a cost that is not an amount, is a figure that cannot be
 * read: unavailable, never rounded in the creator's favor.
 */
export function orderProfit(order: OrderMoney): Profit {
  if (!known(order.paid) || !known(order.refunded) || !known(order.fee) || !known(order.otherCosts)) return { state: "unavailable" };
  if (order.lines.some((l) => !Number.isSafeInteger(l.units) || l.units < 0 || (l.costPerSale !== null && !known(l.costPerSale)))) return { state: "unavailable" };
  if (order.lines.some((l) => l.costPerSale === null)) return { state: "incomplete", why: "cost not set" };
  const cost = order.lines.reduce((n, l) => n + (l.costPerSale as number) * l.units, 0);
  const cents = order.paid - order.refunded - order.fee - cost - order.otherCosts;
  return Number.isSafeInteger(cents) ? { state: "complete", cents: cents || 0 } : { state: "unavailable" };
}

/**
 * A period's profit, per currency: the orders' profits added up, less the
 * ads recorded in that currency. One incomplete or unavailable order makes
 * its currency's total so too, said as such.
 */
export function periodProfit(orders: OrderMoney[], ads: Record<string, number | null>): Map<string, Profit> {
  const out = new Map<string, Profit>();
  const lower = (currency: string) => currency.toLowerCase();
  const spentIn = new Map(Object.entries(ads).map(([currency, cents]) => [lower(currency), cents] as const));
  // A currency with ads and no order still has its spending: a loss, never lost.
  for (const currency of spentIn.keys()) out.set(currency, { state: "complete", cents: 0 });
  for (const order of orders) {
    const currency = lower(order.currency);
    const so = out.get(currency) ?? { state: "complete", cents: 0 };
    const one = orderProfit(order);
    if (so.state === "unavailable" || one.state === "unavailable") out.set(currency, { state: "unavailable" });
    else if (so.state === "incomplete" || one.state === "incomplete") out.set(currency, { state: "incomplete", why: "cost not set" });
    else out.set(currency, { state: "complete", cents: so.cents + one.cents });
  }
  for (const [currency, profit] of out) {
    const spent = spentIn.has(currency) ? spentIn.get(currency)! : 0;
    if (profit.state === "complete") out.set(currency, known(spent) ? { state: "complete", cents: profit.cents - spent || 0 } : { state: "unavailable" });
  }
  return out;
}

/** An order's line with what it was charged, for sharing the order's own figures between its products. */
export type ChargedLine = OrderLine & { optionId?: string | null; charged: number };

/** How a product's share of an order is worked out, said beside the per-product figures. */
export const SHARE_WORDS = "Stripe's fee, refunds and other costs of an order are shared between its products by what each was charged. Ads are not included per product.";

/** The key of one product or option in productProfit's answer: never two products under one key. */
export function productKey(currency: string, productId: string, optionId: string | null | undefined): string {
  return JSON.stringify([currency.toLowerCase(), productId, optionId ?? null]);
}

/**
 * Each product's (and option's) profit before taxes over a period, per
 * currency: an order's fee, refund and other costs shared between its lines
 * by what each line was charged, the rounding left on the last line so the
 * parts add up to the order exactly; each line's own cost. An order with no
 * line, or whose lines were charged nothing, cannot be shared: it reads
 * "Count unavailable" (an order with no line under an empty product key),
 * so the products never add up to less than the period without saying so.
 * Unknown stays unknown, a cost not set stays incomplete, line by line.
 */
export function productProfit(orders: (Omit<OrderMoney, "lines"> & { lines: ChargedLine[] })[]): Map<string, Profit> {
  const out = new Map<string, Profit>();
  const key = (currency: string, line: ChargedLine) => productKey(currency, line.productId, line.optionId);
  const add = (k: string, p: Profit) => {
    const so = out.get(k) ?? { state: "complete", cents: 0 };
    if (so.state === "unavailable" || p.state === "unavailable") out.set(k, { state: "unavailable" });
    else if (so.state === "incomplete" || p.state === "incomplete") out.set(k, { state: "incomplete", why: "cost not set" });
    else out.set(k, { state: "complete", cents: so.cents + p.cents });
  };
  for (const order of orders) {
    const total = order.lines.reduce((n, l) => n + (Number.isSafeInteger(l.charged) && l.charged >= 0 ? l.charged : Number.NaN), 0);
    const whole = orderProfit(order);
    // Nothing charged to share by (no line, or every line charged nothing while something was paid): no product can be given its part.
    if (whole.state === "unavailable" || !Number.isSafeInteger(total) || !order.lines.length || total <= 0) {
      for (const line of order.lines) add(key(order.currency, line), { state: "unavailable" });
      if (!order.lines.length) add(productKey(order.currency, "", null), { state: "unavailable" });
      continue;
    }
    const shared = (order.paid as number) - (order.refunded as number) - (order.fee as number) - (order.otherCosts as number);
    let given = 0;
    order.lines.forEach((line, i) => {
      // The last line takes the rounding, so the parts add up to the order's own figure.
      // In BigInt, so a large order's product of two amounts never loses a cent; floored, toward minus infinity for a loss.
      const exact = (BigInt(shared) * BigInt(line.charged)) / BigInt(total);
      const floored = exact * BigInt(total) > BigInt(shared) * BigInt(line.charged) ? exact - BigInt(1) : exact;
      const part = i === order.lines.length - 1 ? shared - given : Number(floored);
      given += part;
      add(key(order.currency, line), line.costPerSale === null ? { state: "incomplete", why: "cost not set" } : { state: "complete", cents: part - line.costPerSale * line.units });
    });
  }
  return out;
}

/** How a profit reads: a loss said in words, never only by a color. */
export function profitWords(profit: Profit, currency: string): string {
  if (profit.state === "unavailable") return "Count unavailable";
  if (profit.state === "incomplete") return "Incomplete: cost not set";
  if (profit.cents < 0) return `${formatMoney(-profit.cents, currency)} loss`;
  return formatMoney(profit.cents, currency);
}

/**
 * One row of the export, with the panel's own words: the shared CSV writer
 * (lib/csv.ts), which keeps a cell that starts like a formula, spaces first
 * included, as text. Amounts go as the words the panel shows ("$9.72 loss"),
 * so the file never says more than the page.
 */
export function csvRow(cells: (string | number)[]): string {
  return csvLine(cells);
}
