/**
 * Reading a store's paid sales of one period for its accounting app's file
 * (queue item 37 [F6], 6 November 2026; the file itself is
 * lib/accounting-export-rules.ts, the download app/api/store/export with
 * what=sales and format=xero or quickbooks).
 *
 * The same sales the studio's sales file reads (lib/stats.ts, readPaidSales):
 * the checkouts this store opened on its own Stripe account that were paid,
 * the one-click extras taken after them, and its PayPal sales; with the same
 * ceiling, EXPORT_PAGES pages of a hundred of each Stripe list and
 * EXPORT_PAGES hundred PayPal sales, behind the same counted window
 * (tests/plan-cost-registry.ts, line "studio"). Since the renewals are read
 * (ALTO 1 below) it walks a third Stripe list, the paid and pending invoices,
 * at the same ceiling: Stripe bills no API call, but the request runs longer
 * than the sales file's, a difference no registry line prices yet.
 * Stripe is asked only for the period (created[gte] and created[lt]).
 *
 * Unlike that file, nothing here is guessed or left out quietly: books are
 * filed from it. Every Stripe page is read in its exact shape
 * (lib/stripe-list.ts, readStripePage); a row that cannot be read, a paid
 * sale without a whole amount, a currency, its date in the period or the tax
 * it carried, a PayPal record that is not exactly what was written, or more
 * sales than one file reads, and the answer is that no file can be made,
 * with why. A sale's tax: a checkout's is Stripe's total_details.amount_tax;
 * a one-click extra carries none (lib/upsell.ts: it cannot carry Stripe Tax,
 * so with tax on there is none), nor a PayPal order (lib/paypal-sales.ts
 * asks PayPal for the price alone).
 *
 * The payments after the first are sales too (money review on #2996, ALTO 1):
 * each paid invoice Stripe made because a membership's or a payment plan's
 * period came round (billing_reason "subscription_cycle", as lib/stats.ts
 * renewalEntries reads them), on a subscription this store opened, net of the
 * invoice's own tax (`total_taxes`, or `tax` in older API versions). A first
 * invoice is its checkout's sale already, so it is not read again.
 *
 * A day whose payments are not all settled makes no file yet (money review on
 * #2996, MÉDIO 2): a checkout of the period still open or complete with its
 * payment processing, a one-click extra processing, or a renewal still a
 * draft, open or uncollectible (any of them can still be paid). Its sale would
 * come out later under the same invoice number with a larger total, and the
 * accounting app refuses a number it already has.
 */
import type { AccountingPeriod, AccountingSale } from "@/lib/accounting-export-rules";
import { listingFinder } from "@/lib/catalog";
import { type Paid, readPayPalSalesExact } from "@/lib/paypal-sales";
import { EXPORT_PAGES } from "@/lib/stats";
import { type Store, saleHandles } from "@/lib/store";
import { onAccount } from "@/lib/stripe-account";
import { StripeListUnreadable, hasOwnField, ownField, plainObject, readStripePage } from "@/lib/stripe-list";

/** Pages of a hundred read of each Stripe list: the sales file's own ceiling. */
export const ACCOUNTING_PAGES = EXPORT_PAGES;
/** PayPal sales read at the most: the sales file's own ceiling (readPaidSales, pages * 100). */
export const ACCOUNTING_PAYPAL_LIMIT = EXPORT_PAGES * 100;

export type AccountingRead = { ok: true; sales: AccountingSale[] } | { ok: false; reason: "too_many" | "unreadable" | "pending" };

export type AccountingDeps = {
  stripe: (path: string) => Promise<unknown>;
  paypal: (statsId: string | null, from: number, to: number, limit: number) => Promise<{ sales: Paid[]; more: boolean } | null>;
  title: (product: string) => Promise<string>;
};

class Unreadable extends Error {}
class TooMany extends Error {}
class Pending extends Error {}

/** One-click extras whose payment can still succeed. */
const EXTRA_PENDING = new Set(["processing", "requires_action", "requires_confirmation", "requires_capture"]);
/** A renewal invoice's statuses: paid is a sale, void never will be; the others can still be paid. */
const INVOICE_PENDING = new Set(["draft", "open", "uncollectible"]);

const wholeFrom = (value: unknown, min = 0): number | null => (typeof value === "number" && Number.isSafeInteger(value) && value >= min ? value : null);
const currencyOf = (value: unknown): string | null => (typeof value === "string" && /^[a-zA-Z]{3}$/.test(value) ? value.toLowerCase() : null);
/** Metadata as Stripe gives it: a plain object of text, or none at all. */
function metaOf(row: Record<string, unknown>): Record<string, string> | null {
  if (!hasOwnField(row, "metadata")) return {};
  const meta = ownField(row, "metadata");
  if (meta === null) return {};
  if (!plainObject(meta)) return null;
  const out: Record<string, string> = {};
  for (const key of Object.keys(meta)) {
    const value = ownField(meta, key);
    if (typeof value !== "string") return null;
    out[key] = value;
  }
  return out;
}

/** The metadata of the subscription an invoice is for, where either of Stripe's API versions keeps it; null when it cannot be read. */
function invoiceMetaOf(row: Record<string, unknown>): Record<string, string> | null {
  const parent = hasOwnField(row, "parent") ? ownField(row, "parent") : null;
  const holder = plainObject(parent) && hasOwnField(parent, "subscription_details") && ownField(parent, "subscription_details") !== null
    ? ownField(parent, "subscription_details")
    : hasOwnField(row, "subscription_details") ? ownField(row, "subscription_details") : null;
  if (holder === null || holder === undefined) return {};
  if (!plainObject(holder)) return null;
  return metaOf(holder);
}

/** An invoice's tax: the sum of `total_taxes` (newer API versions), or `tax` (older; null is none); null when neither reads. */
function invoiceTaxOf(row: Record<string, unknown>): number | null {
  if (hasOwnField(row, "total_taxes")) {
    const taxes = ownField(row, "total_taxes");
    if (!Array.isArray(taxes)) return null;
    let sum = 0;
    for (const one of taxes) {
      const amount = plainObject(one) ? wholeFrom(ownField(one, "amount")) : null;
      if (amount === null) return null;
      sum += amount;
    }
    return sum;
  }
  if (!hasOwnField(row, "tax")) return null;
  const tax = ownField(row, "tax");
  return tax === null ? 0 : wholeFrom(tax);
}

/** A paid sale of the period, or throws Unreadable when one that should be is not whole. */
function sale(period: AccountingPeriod, product: string, amount: unknown, tax: number | null, currency: unknown, created: unknown): Omit<AccountingSale, "title"> {
  const total = wholeFrom(amount);
  const code = currencyOf(currency);
  const at = wholeFrom(created);
  if (total === null || code === null || at === null || tax === null || tax > total || at < period.from || at >= period.to) throw new Unreadable();
  return { at, product, currency: code, net: total - tax, tax };
}

export async function readAccountingSales(store: Store, period: AccountingPeriod, deps: AccountingDeps = defaultDeps(store)): Promise<AccountingRead> {
  const handles = saleHandles(store);
  const found: Omit<AccountingSale, "title">[] = [];
  try {
    const paypal = await deps.paypal(store.statsId, period.from, period.to, ACCOUNTING_PAYPAL_LIMIT);
    if (!paypal) throw new Unreadable();
    if (paypal.more) throw new TooMany();
    for (const paid of paypal.sales) found.push(sale(period, paid.product, paid.cents, 0, paid.currency, paid.at));

    if (store.stripeAccountId) {
      // A list read, never a checkout made: the path carries its query, as lib/stats.ts readPaidSales writes it.
      const walk = async (list: string, take: (row: Record<string, unknown>) => void) => {
        let after = "";
        for (let page = 0; page < ACCOUNTING_PAGES; page += 1) {
          const read = readStripePage(await deps.stripe(`${list}&created[gte]=${period.from}&created[lt]=${period.to}${after ? `&starting_after=${encodeURIComponent(after)}` : ""}`));
          if (read.unreadable > 0) throw new Unreadable();
          read.rows.forEach(take);
          if (!read.hasMore) return;
          if (!read.lastId) throw new Unreadable();
          after = read.lastId;
        }
        throw new TooMany();
      };
      const checkouts = walk("/checkout/sessions?limit=100", (row) => {
        const meta = metaOf(row);
        const status = ownField(row, "status");
        const paid = ownField(row, "payment_status");
        if (!meta || typeof status !== "string" || typeof paid !== "string") throw new Unreadable();
        if (!handles.has(meta.store ?? "")) return;
        // Still open, or complete with its payment processing: it can still be paid, dated in this period (MÉDIO 2).
        if (status === "open" || (status === "complete" && paid === "unpaid")) throw new Pending();
        if (status !== "complete" || paid !== "paid") return;
        const totals = ownField(row, "total_details");
        const tax = plainObject(totals) ? wholeFrom(ownField(totals, "amount_tax")) : null;
        found.push(sale(period, meta.product ?? "", ownField(row, "amount_total"), tax, ownField(row, "currency"), ownField(row, "created")));
      });
      const extras = walk("/payment_intents?limit=100", (row) => {
        const meta = metaOf(row);
        const status = ownField(row, "status");
        if (!meta || typeof status !== "string") throw new Unreadable();
        if (meta.kind !== "upsell" || !handles.has(meta.store ?? "")) return;
        if (EXTRA_PENDING.has(status)) throw new Pending();
        if (status !== "succeeded") return;
        found.push(sale(period, meta.product ?? "", ownField(row, "amount"), 0, ownField(row, "currency"), ownField(row, "created")));
      });
      // The payments after the first (ALTO 1): renewals and later instalments of this store's subscriptions.
      const renewals = walk("/invoices?limit=100", (row) => {
        const reason = ownField(row, "billing_reason");
        const status = ownField(row, "status");
        if (typeof reason !== "string" || typeof status !== "string") throw new Unreadable();
        if (reason !== "subscription_cycle") return;
        const meta = invoiceMetaOf(row);
        if (!meta) throw new Unreadable();
        if (!handles.has(meta.store ?? "")) return;
        if (INVOICE_PENDING.has(status)) throw new Pending();
        if (status !== "paid") {
          if (status === "void") return;
          throw new Unreadable();
        }
        found.push(sale(period, meta.product ?? "", ownField(row, "amount_paid"), invoiceTaxOf(row), ownField(row, "currency"), ownField(row, "created")));
      });
      // All are read to their end or their first refusal; one failing is the whole answer, a pending one first.
      const settled = await Promise.allSettled([checkouts, extras, renewals]);
      for (const result of settled) if (result.status === "rejected" && result.reason instanceof Pending) throw result.reason;
      for (const result of settled) if (result.status === "rejected") throw result.reason;
    }
    const titles = new Map<string, string>();
    for (const product of new Set(found.map((s) => s.product))) titles.set(product, product ? await deps.title(product) : "");
    return { ok: true, sales: found.map((s) => ({ ...s, title: titles.get(s.product) || s.product })) };
  } catch (error) {
    if (error instanceof TooMany) return { ok: false, reason: "too_many" };
    if (error instanceof Pending) return { ok: false, reason: "pending" };
    if (!(error instanceof Unreadable || error instanceof StripeListUnreadable)) console.error("reading sales for an accounting file failed", error);
    return { ok: false, reason: "unreadable" };
  }
}

function defaultDeps(store: Store): AccountingDeps {
  const find = listingFinder(store);
  return {
    stripe: (path) => onAccount("GET", store.stripeAccountId as string, path),
    paypal: readPayPalSalesExact,
    title: async (product) => (await find(product))?.title ?? "",
  };
}
