/**
 * The sales filters, and the total and average of what a filter keeps (767 [STN14], unit 1; Claude 4,
 * 9 November 2026). Pure and browser-safe: nothing here reads Stripe or Redis.
 *
 * A filter lives in the page's address (filterQuery, readSalesFilter), so the filtered list can be bookmarked
 * and saved by name as the same link (unit 3: the saved filters' rules at the end of this file, kept by
 * lib/sales-filters.ts). The next units: the filter bar on the studio's buyer list, bulk actions with a counter
 * and undo, and where each buyer came from.
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

// ------------------------------------------------------------ saved filters (unit 3)

/**
 * The most saved filters a store keeps (lib/sales-filters.ts): a bound on what is stored, the same on every plan,
 * never a plan limit (tests/store-data-registry.ts prices it). Ten names fit on one row of choices.
 */
export const MAX_SAVED_FILTERS = 10;
/** The longest name a saved filter keeps. */
export const MAX_SAVED_FILTER_NAME = 60;
/**
 * The most one saved filter weighs as kept (its JSON, in bytes). What the fields allow stays well under it (a
 * product of FILTER_TEXT_MAX characters written in the address is at most 900 bytes); a filter over it is refused.
 */
export const SAVED_FILTER_BYTES = 2_048;
export const SAVED_FILTER_ID = /^[0-9a-f]{12}$/;

/** A filter kept under a name: `query` is the page's address for it (filterQuery), never with a buyer's address. */
export type SavedFilter = { id: string; name: string; query: string };

export type SavedFilterRefusal = "name" | "empty" | "email" | "taken" | "full" | "gone" | "long";

/** What the studio says for each refusal, and when the saved filters could not be read. Plain words, no plan talk. */
export const SAVED_FILTER_REFUSALS: Record<SavedFilterRefusal | "unavailable", string> = {
  name: "Give this filter a name.",
  empty: "Choose at least one filter before you save it.",
  email: "A saved filter cannot keep an email address. Remove addresses from its name and product words, and clear the email box, then save.",
  taken: "You already have a filter with this name. Choose another name.",
  full: `A store keeps up to ${MAX_SAVED_FILTERS} saved filters. Delete one to save a new one.`,
  gone: "This filter was deleted. Open the list again.",
  long: "This filter is too long to save. Shorten the product words.",
  unavailable: "Your saved filters could not be read just now. Try again in a moment.",
};

/** Bytes of a text as UTF-8, in the browser as on the server. */
export const utf8Bytes = (text: string): number => new TextEncoder().encode(text).length;

/** Address-shaped text cannot be kept outside the buyer's erasure path, even in a name or product field. */
export const savedFilterHasAddress = (text: string): boolean => /[^\s@]+@[^\s@]+/u.test(text);

/** A name as it is kept: control characters and runs of spaces made one space, trimmed, cut at the most; "" for none. */
export function savedFilterName(raw: unknown): string {
  if (typeof raw !== "string") return "";
  const clean = raw.replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim();
  return Array.from(clean).slice(0, MAX_SAVED_FILTER_NAME).join("").trim();
}

/** The filter a page's address says (what follows "?"), read as readSalesFilter reads it: a field given twice is left out. */
export function filterFromQuery(query: string): SalesFilter {
  const fields: Query = {};
  for (const [name, value] of new URLSearchParams(query)) {
    const before = fields[name];
    fields[name] = before === undefined ? value : [...(Array.isArray(before) ? before : [before]), value];
  }
  return readSalesFilter(fields);
}

/**
 * A kept saved filter, read exactly: null for anything that is not one as lib/sales-filters.ts writes it (the
 * three fields and no other, the name and the address as they are kept, a filter that keeps something out and
 * holds no buyer's address). Its reader takes null as unknown, never as a filter to leave out (CX-123 rule 24).
 */
export function parseSavedFilter(raw: unknown): SavedFilter | null {
  if (typeof raw !== "string" || utf8Bytes(raw) > SAVED_FILTER_BYTES) return null;
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const { id, name, query, ...rest } = value as Record<string, unknown>;
  if (Object.keys(rest).length || typeof id !== "string" || !SAVED_FILTER_ID.test(id)) return null;
  if (typeof name !== "string" || !name || savedFilterName(name) !== name) return null;
  if (typeof query !== "string") return null;
  const filter = filterFromQuery(query);
  if (!isFiltered(filter) || filter.email || savedFilterHasAddress(name) || savedFilterHasAddress(filter.product) || filterQuery(filter) !== query) return null;
  return { id, name, query };
}

/** Saved filters by name, any case, then by id: the order the studio lists them in. */
export function byName(a: SavedFilter, b: SavedFilter): number {
  const x = a.name.toLowerCase();
  const y = b.name.toLowerCase();
  return x < y ? -1 : x > y ? 1 : a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}
