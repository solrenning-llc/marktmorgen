/**
 * The creator's tax summary (601 [KB22], unit U4): the tax Stripe added to
 * the store's checkouts in each window, by the address Stripe taxed, each
 * currency on its own. A record for the creator, not tax advice and not Marktmorgen's
 * own filing (that is 335 [FR1]): every sale is a direct charge on the
 * creator's own Stripe account, so the tax is theirs and never passes through
 * Marktmorgen.
 *
 * It reads nothing of its own: it is computed from the sales the numbers
 * already read (lib/stats.ts, readSales), so its cost is inside that reading's
 * (SALES_READ_SHAPE, lib/read-ceilings.ts) and inside its kept copy's ceiling
 * (READING_COPY_MAX_BYTES, lib/store-readings.ts).
 *
 * Unknown is never zero: a checkout whose total_details.amount_tax is not a
 * whole, non-negative, exact number of cents is counted as unread, and the
 * page says it could not be read. Two kinds of sale are known without that
 * field: a one-click extra is a bare payment, charged with no tax calculation
 * (lib/upsell.ts: none is offered while tax is on), so Stripe collected $0 on
 * it; a PayPal sale was not paid through Stripe at all, so it is counted
 * aside. Currencies are never converted or added together.
 */

/** The regions listed per currency at the most; the rest are rolled into one row, so the totals stay exact. */
export const TAX_REGION_ROWS = 20;
/** The currencies listed per window at the most; sales in the rest are counted, never added to another currency. */
export const TAX_CURRENCY_ROWS = 4;
/** Countries whose buyers are placed by state or province: where Stripe Tax registrations are per state. */
export const BY_STATE = new Set(["US", "CA"]);

export type TaxSale = { created: number; currency: string; row: Record<string, unknown>; upsell: boolean };
export type SaleTax = { kind: "read"; cents: number } | { kind: "unread" } | { kind: "paypal" };
/** One region: the sales in it, the tax read on them, and how many of them had a tax that could not be read. */
export type TaxRegion = { region: string; sales: number; taxCents: number; unread: number };
export type TaxCurrency = { currency: string; sales: number; taxCents: number; unread: number; regions: TaxRegion[]; more: TaxRegion | null };
export type TaxWindow = { currencies: TaxCurrency[]; moreCurrencies: number; paypal: number };
export type TaxSummary = { d7: TaxWindow; d30: TaxWindow; d90: TaxWindow; partial: boolean };

const obj = (value: unknown): Record<string, unknown> | null =>
  value !== null && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null;

/** What Stripe collected in tax on one sale, as its record says it. */
export function taxOf(sale: TaxSale): SaleTax {
  if (sale.row.object === "paypal.order") return { kind: "paypal" };
  if (sale.upsell) return { kind: "read", cents: 0 };
  const tax = obj(sale.row.total_details)?.amount_tax;
  return typeof tax === "number" && Number.isSafeInteger(tax) && tax >= 0 ? { kind: "read", cents: tax } : { kind: "unread" };
}

/**
 * Where Stripe taxed the sale: "US-NY", "CA-ON", "DE"; "" when the payment gave no place. Stripe taxes a checkout
 * at the shipping address when it collected one, and at the payment's address otherwise (docs.stripe.com/tax/
 * checkout/page, "Collect a shipping address", read by Claude 2 on 7 November 2026), so a shipped order is placed
 * by where it went, read in the order lib/shipping-address.ts reads it (Claude 2's review of #2980, HIGH). A
 * shipping address with no country that reads is no place, never the payment's: that is not where it was taxed.
 * "US" or "CA" alone is a payment that gave no state or province (Checkout with tax on asks only for what the tax
 * needs, often the ZIP code), never the whole country (stateNotGiven).
 */
export function regionOf(row: Record<string, unknown>): string {
  const shipped = obj(obj(row.collected_information)?.shipping_details) ?? obj(row.shipping_details) ?? obj(row.shipping);
  const address = shipped ? obj(shipped.address) : obj(obj(row.customer_details)?.address);
  const country = typeof address?.country === "string" && /^[A-Z]{2}$/.test(address.country) ? address.country : "";
  if (!country) return "";
  const state = typeof address?.state === "string" && /^[A-Z0-9]{1,3}$/.test(address.state) ? address.state : "";
  return BY_STATE.has(country) && state ? `${country}-${state}` : country;
}

/** Whether a region is a country placed by state whose payment gave no state or province ("US", "CA"). */
export function stateNotGiven(region: string): boolean {
  return BY_STATE.has(region);
}

const dayKey = (ms: number) => new Date(ms).toISOString().slice(0, 10);

function windowOf(sales: TaxSale[], cut: string, storeCurrency: string): TaxWindow {
  const byCurrency = new Map<string, Map<string, TaxRegion>>();
  let paypal = 0;
  for (const sale of sales) {
    if (dayKey(sale.created) < cut) continue;
    const tax = taxOf(sale);
    if (tax.kind === "paypal") {
      paypal += 1;
      continue;
    }
    const regions = byCurrency.get(sale.currency) ?? new Map<string, TaxRegion>();
    byCurrency.set(sale.currency, regions);
    const region = sale.upsell ? "" : regionOf(sale.row);
    const row = regions.get(region) ?? { region, sales: 0, taxCents: 0, unread: 0 };
    row.sales += 1;
    if (tax.kind === "read") row.taxCents += tax.cents;
    else row.unread += 1;
    regions.set(region, row);
  }
  const all: TaxCurrency[] = [...byCurrency].map(([currency, regions]) => {
    const rows = [...regions.values()].sort(
      (a, b) => Number(a.region === "") - Number(b.region === "") || b.taxCents - a.taxCents || b.sales - a.sales || a.region.localeCompare(b.region),
    );
    const shown = rows.slice(0, TAX_REGION_ROWS);
    const rest = rows.slice(TAX_REGION_ROWS);
    const sum = (list: TaxRegion[], key: "sales" | "taxCents" | "unread") => list.reduce((n, r) => n + r[key], 0);
    return {
      currency,
      sales: sum(rows, "sales"),
      taxCents: sum(rows, "taxCents"),
      unread: sum(rows, "unread"),
      regions: shown,
      more: rest.length ? { region: "", sales: sum(rest, "sales"), taxCents: sum(rest, "taxCents"), unread: sum(rest, "unread") } : null,
    };
  });
  all.sort((a, b) => Number(b.currency === storeCurrency) - Number(a.currency === storeCurrency) || b.sales - a.sales || a.currency.localeCompare(b.currency));
  const currencies = all.slice(0, TAX_CURRENCY_ROWS);
  return { currencies, moreCurrencies: all.slice(TAX_CURRENCY_ROWS).reduce((n, c) => n + c.sales, 0), paypal };
}

/**
 * The summary for the three windows, from the sales read (each window from its
 * cut, a UTC day, on). `partial` is the reading's own: when not every sale was
 * read, the page shows no figure, because a part looks like a whole.
 */
export function taxSummary(sales: TaxSale[], cuts: { d7: string; d30: string; d90: string }, storeCurrency: string, partial: boolean): TaxSummary {
  return {
    d7: windowOf(sales, cuts.d7, storeCurrency),
    d30: windowOf(sales, cuts.d30, storeCurrency),
    d90: windowOf(sales, cuts.d90, storeCurrency),
    partial,
  };
}
