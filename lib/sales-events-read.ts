/**
 * What changed since a kept reading of the sales numbers' inputs (C4-36 (B);
 * inbox C4-41): Stripe's events on the creator's account, every page until
 * Stripe says there is no more, and PayPal's sales and refunds written down
 * since, under the same rule. Anything short of that answers null and the
 * caller reads the whole: a page that is not whole or does not read, more
 * pages than EVENTS_PAGES, a kept reading older than EVENTS_MAX_AGE_MS
 * (Stripe keeps events 30 days; a day is far inside it), or PayPal's rows not
 * read in full (guarantees (a), (b), (e)).
 *
 * The requests are the whole reading's own: the same account, with no
 * version of their own, so the objects read the same (guarantee (c)).
 */
import { paypalPaymentId, readPayPalRefundsWithCoverage, readPayPalSales } from "@/lib/paypal-sales";
import { SALES_EVENT_TYPE_LIST, type PayPalSince, type StripeEvent } from "@/lib/sales-events";
import { financialPage, payPalSale, type RefundRow } from "@/lib/stats";
import type { Store } from "@/lib/store";
import { onAccount } from "@/lib/stripe-account";

/** Pages of a hundred events read at the most; past it, the whole reading. */
export const EVENTS_PAGES = 5;
/** Read again from a little before the kept reading, so an event written as it was made is never missed. */
export const EVENTS_OVERLAP_SECONDS = 300;
/** A kept reading older than this is never brought up to date: the whole reading instead. */
export const EVENTS_MAX_AGE_MS = 24 * 3_600_000;
/** PayPal's sales and refunds read since the kept reading at the most; more than these, the whole reading. */
export const PAYPAL_SINCE_SALES = 40;
export const PAYPAL_SINCE_REFUNDS = 20;

const isEvent = (row: Record<string, unknown>): row is Record<string, unknown> & StripeEvent =>
  typeof row.type === "string" && typeof row.created === "number" && Boolean(row.data) && typeof row.data === "object" &&
  Boolean((row.data as { object?: unknown }).object) && typeof (row.data as { object?: unknown }).object === "object";

/** Stripe's events of the read types since `sinceMs`, every page; null when they cannot all be read. */
export async function readSalesEventsSince(store: Pick<Store, "stripeAccountId">, sinceMs: number, now: number): Promise<StripeEvent[] | null> {
  if (!store.stripeAccountId) return [];
  if (!(now - sinceMs >= 0 && now - sinceMs <= EVENTS_MAX_AGE_MS)) return null;
  const since = Math.floor(sinceMs / 1000) - EVENTS_OVERLAP_SECONDS;
  const out: StripeEvent[] = [];
  const seen = new Set<string>();
  let after = "";
  try {
    for (let page = 0; page < EVENTS_PAGES; page += 1) {
      const query = new URLSearchParams({ limit: "100", "created[gte]": String(since) });
      for (const type of SALES_EVENT_TYPE_LIST) query.append("types[]", type);
      if (after) query.set("starting_after", after);
      const list = (await onAccount("GET", store.stripeAccountId, `/events?${query}`)) as { data?: unknown; has_more?: unknown };
      const rows = financialPage(list, seen);
      for (const row of rows) {
        if (!isEvent(row)) return null;
        out.push(row);
      }
      if (!list.has_more) return out;
      after = rows[rows.length - 1].id as string;
    }
    return null;
  } catch {
    return null;
  }
}

/** PayPal's sales and refunds since `sinceMs`, read as the whole reading reads them; null when not in full. */
export async function readPayPalSince(store: Pick<Store, "statsId">, sinceMs: number): Promise<PayPalSince | null> {
  const since = Math.floor(sinceMs / 1000) - EVENTS_OVERLAP_SECONDS;
  try {
    const [sales, refunds] = await Promise.all([readPayPalSales(store.statsId, since, PAYPAL_SINCE_SALES), readPayPalRefundsWithCoverage(store.statsId, since, PAYPAL_SINCE_REFUNDS)]);
    if (sales.partial || refunds.partial) return null;
    return {
      sales: sales.sales.map(payPalSale),
      refunds: refunds.rows.map((r): RefundRow => ({ created: r.at * 1000, cents: r.cents, currency: r.currency, paymentIntent: paypalPaymentId(r.capture), id: `paypal-refund:${r.capture}` })),
    };
  } catch {
    return null;
  }
}
