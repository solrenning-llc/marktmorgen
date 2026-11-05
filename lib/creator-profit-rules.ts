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

/** Keep intermediate sums exact; only public amounts must fit a safe number. */
type ExactProfit = { state: "complete"; cents: bigint } | Exclude<Profit, { state: "complete" }>;
const exactProfit = (value: Profit): ExactProfit => value.state === "complete" ? { state: "complete", cents: BigInt(value.cents) } : value;
function publicProfit(value: ExactProfit): Profit {
  if (value.state !== "complete") return value;
  if (value.cents < BigInt(Number.MIN_SAFE_INTEGER) || value.cents > BigInt(Number.MAX_SAFE_INTEGER)) return { state: "unavailable" };
  return { state: "complete", cents: Number(value.cents) };
}
function addExact(before: ExactProfit | undefined, next: ExactProfit): ExactProfit {
  const prior = before ?? { state: "complete", cents: BigInt(0) };
  if (prior.state === "unavailable" || next.state === "unavailable") return { state: "unavailable" };
  if (prior.state === "incomplete" || next.state === "incomplete") return { state: "incomplete", why: "cost not set" };
  return { state: "complete", cents: prior.cents + next.cents };
}


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
  const cost = order.lines.reduce((n, l) => n + BigInt(l.costPerSale as number) * BigInt(l.units), BigInt(0));
  return publicProfit({ state: "complete", cents: BigInt(order.paid) - BigInt(order.refunded) - BigInt(order.fee) - cost - BigInt(order.otherCosts) });
}

/**
 * A period's profit, per currency: the orders' profits added up, less the
 * ads recorded in that currency. One incomplete or unavailable order makes
 * its currency's total so too, said as such.
 */
export function periodProfit(orders: OrderMoney[], ads: Record<string, number | null>): Map<string, Profit> {
  const out = new Map<string, ExactProfit>();
  const lower = (currency: string) => currency.toLowerCase();
  const spentIn = new Map<string, number | null>();
  for (const [currency, cents] of Object.entries(ads)) {
    const code = lower(currency);
    // Two spellings cannot prove whether the same spend was repeated or two
    // costs were supplied: neither an unknown cost nor a real cost may vanish.
    spentIn.set(code, spentIn.has(code) ? null : cents);
  }
  // A currency with ads and no order still has its spending: a loss, never lost.
  for (const currency of spentIn.keys()) out.set(currency, { state: "complete", cents: BigInt(0) });
  for (const order of orders) {
    const currency = lower(order.currency);
    out.set(currency, addExact(out.get(currency), exactProfit(orderProfit(order))));
  }
  for (const [currency, profit] of out) {
    const spent = spentIn.has(currency) ? spentIn.get(currency)! : 0;
    if (profit.state === "complete") out.set(currency, known(spent) ? { state: "complete", cents: profit.cents - BigInt(spent) } : { state: "unavailable" });
  }
  return new Map([...out].map(([currency, profit]) => [currency, publicProfit(profit)] as const));
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
  const out = new Map<string, ExactProfit>();
  const key = (currency: string, line: ChargedLine) => productKey(currency, line.productId, line.optionId);
  const add = (k: string, profit: ExactProfit) => out.set(k, addExact(out.get(k), profit));
  for (const order of orders) {
    const total = order.lines.reduce((n, l) => n + (Number.isSafeInteger(l.charged) && l.charged >= 0 ? l.charged : Number.NaN), 0);
    const whole = orderProfit(order);
    // Nothing charged to share by (no line, or every line charged nothing while something was paid): no product can be given its part.
    if (whole.state === "unavailable" || !Number.isSafeInteger(total) || !order.lines.length || total <= 0) {
      for (const line of order.lines) add(key(order.currency, line), { state: "unavailable" });
      if (!order.lines.length) add(productKey(order.currency, "", null), { state: "unavailable" });
      continue;
    }
    const shared = BigInt(order.paid as number) - BigInt(order.refunded as number) - BigInt(order.fee as number) - BigInt(order.otherCosts as number);
    let given = BigInt(0);
    order.lines.forEach((line, i) => {
      // The last line takes the rounding, so the parts add up to the order's own figure.
      // In BigInt, so a large order's product of two amounts never loses a cent; floored, toward minus infinity for a loss.
      const exact = (shared * BigInt(line.charged)) / BigInt(total);
      const floored = exact * BigInt(total) > shared * BigInt(line.charged) ? exact - BigInt(1) : exact;
      const part = i === order.lines.length - 1 ? shared - given : floored;
      given += part;
      add(key(order.currency, line), line.costPerSale === null ? { state: "incomplete", why: "cost not set" } : { state: "complete", cents: part - BigInt(line.costPerSale) * BigInt(line.units) });
    });
  }
  return new Map([...out].map(([currency, profit]) => [currency, publicProfit(profit)] as const));
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
