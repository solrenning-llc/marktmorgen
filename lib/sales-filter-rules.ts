/**
 * The sales filters, and the total and average of what a filter keeps (767 [STN14], unit 1; Claude 4,
 * 9 November 2026). Pure and browser-safe: nothing here reads Stripe or Redis.
 *
 * A filter lives in the page's address (filterQuery, readSalesFilter), so the filtered list can be bookmarked
 * and, in a later unit, saved by name as the same link. The next units: the filter bar on the studio's buyer list,
 * saved filters per store, bulk actions with a counter and undo, and where each buyer came from.
 *
 *   - A filter keeps a sale when every field that is set matches: words of the product's title and part of the
 *     buyer's email (any case), the day it was paid (both ends included, in UTC as the list shows it), and its kind.
 *   - Totals are per currency, never added together. A free trial is an order, but nothing was charged, so it is
 *     out of the average; with nothing charged there is no average, never an average of 0.
 *   - An amount that is not a whole, safe, non-negative number of cents, or a currency that is not three letters,
 *     is unknown: salesTotals then gives no totals at all (null), never a total that counts it as zero
 *     (CX-123 rule 24).
 */

/** What a filter reads of a sale (lib/store-checkout.ts Sale). */
export type FilterableSale = {
  title: string;
  /** In the currency's smallest unit, as Stripe gives it. */
  amount: number;
  currency: string;
  email: string | null;
  /** Seconds since the epoch. */
  paidAt: number;
  trial: boolean;
  isTip: boolean;
  isCall: boolean;
};

export const SALE_KINDS = ["all", "products", "calls", "tips", "trials"] as const;
export type SaleKind = (typeof SALE_KINDS)[number];

export type SalesFilter = { product: string; from: string; to: string; email: string; kind: SaleKind };

export const EMPTY_FILTER: SalesFilter = Object.freeze({ product: "", from: "", to: "", email: "", kind: "all" });

/** The longest text a filter field keeps: enough for a product title or an address, small enough for a link. */
export const FILTER_TEXT_MAX = 100;

type Query = { [key: string]: string | string[] | undefined };

/** One field of the address, only when it is the query's own and given once. */
function field(query: Query, name: string): string {
  if (!Object.hasOwn(query, name)) return "";
  const value = query[name];
  return typeof value === "string" ? value.trim().slice(0, FILTER_TEXT_MAX) : "";
}

/** "YYYY-MM-DD" when it names a real day, else "". */
function dayOf(text: string): string {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(text)) return "";
  const at = Date.parse(`${text}T00:00:00Z`);
  return Number.isFinite(at) && new Date(at).toISOString().slice(0, 10) === text ? text : "";
}

/** The filter the page's address asks for, cleaned: anything it cannot read is left out, never guessed. */
export function readSalesFilter(query: Query): SalesFilter {
  const kind = field(query, "kind");
  return {
    product: field(query, "product"),
    from: dayOf(field(query, "from")),
    to: dayOf(field(query, "to")),
    email: field(query, "email").toLowerCase(),
    kind: (SALE_KINDS as readonly string[]).includes(kind) ? (kind as SaleKind) : "all",
  };
}

/** Whether the filter keeps anything out. */
export function isFiltered(filter: SalesFilter): boolean {
  return Boolean(filter.product || filter.from || filter.to || filter.email || filter.kind !== "all");
}

/** The filter as the page's address says it, with only the fields that are set. */
export function filterQuery(filter: SalesFilter): string {
  const params = new URLSearchParams();
  for (const name of ["product", "from", "to", "email"] as const) if (filter[name]) params.set(name, filter[name]);
  if (filter.kind !== "all") params.set("kind", filter.kind);
  return params.toString();
}

function kindOf(sale: FilterableSale): Exclude<SaleKind, "all"> {
  if (sale.trial) return "trials";
  if (sale.isTip) return "tips";
  if (sale.isCall) return "calls";
  return "products";
}

/** The sales the filter keeps, in the order given. */
export function filterSales<T extends FilterableSale>(sales: readonly T[], filter: SalesFilter): T[] {
  const product = filter.product.toLowerCase();
  const email = filter.email.toLowerCase();
  const from = filter.from ? Date.parse(`${filter.from}T00:00:00Z`) / 1000 : -Infinity;
  const to = filter.to ? Date.parse(`${filter.to}T00:00:00Z`) / 1000 + 86_400 : Infinity;
  return sales.filter(
    (sale) =>
      (!product || sale.title.toLowerCase().includes(product)) &&
      (!email || (sale.email ?? "").toLowerCase().includes(email)) &&
      sale.paidAt >= from &&
      sale.paidAt < to &&
      (filter.kind === "all" || kindOf(sale) === filter.kind),
  );
}

export type SalesTotal = { currency: string; orders: number; charged: number; totalCents: number; averageCents: number | null };

/**
 * The total and average of the sales given, per currency (sorted by its code). Null when any amount or currency
 * is unknown: no total is better than one that is wrong.
 */
export function salesTotals(sales: readonly FilterableSale[]): SalesTotal[] | null {
  const by = new Map<string, { orders: number; charged: number; total: number }>();
  for (const sale of sales) {
    const known = Number.isSafeInteger(sale.amount) && sale.amount >= 0 && /^[a-z]{3}$/i.test(sale.currency);
    if (!known) return null;
    const currency = sale.currency.toUpperCase();
    const sum = by.get(currency) ?? { orders: 0, charged: 0, total: 0 };
    sum.orders += 1;
    if (!sale.trial) {
      sum.charged += 1;
      sum.total += sale.amount;
    }
    if (!Number.isSafeInteger(sum.total)) return null;
    by.set(currency, sum);
  }
  return [...by.entries()]
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([currency, sum]) => ({
      currency,
      orders: sum.orders,
      charged: sum.charged,
      totalCents: sum.total,
      averageCents: sum.charged ? Math.floor(sum.total / sum.charged + 0.5) : null,
    }));
}
