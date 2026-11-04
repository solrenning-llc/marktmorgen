/**
 * GET /api/v1/sales: the store's paid checkouts, newest first, read from the
 * creator's own Stripe account as the studio's list of sales reads them
 * (lib/store-checkout.ts, listSales): only settled checkouts of this store
 * (its handle or one it used before), and only while the store can sell, as
 * the studio shows them. 630 [HN6](19), unit 1.
 *
 * Each sale is written out field by field, in the shape of the sale.completed
 * webhook's data (lib/webhooks.ts), so a tool reads both the same way. What
 * a buyer typed at checkout is not sent here. Refunds are not read per sale:
 * `refunds_checked` says so, and refund.issued tells a tool of each one.
 *
 * The cursor is Stripe's own: the id of the last checkout of the page Stripe
 * gave, so a page whose checkouts are all another store's comes back empty
 * with a `next` to go on from. One request to Stripe per call: the payment
 * moment comes from the same request, expanded (paidAt).
 */
import { isSettled } from "@/lib/instant-pay";
import { onAccount } from "@/lib/stripe-account";
import { saleHandles, type Store } from "@/lib/store";
import { readListings } from "@/lib/catalog";
import { sourceOf } from "@/lib/webhooks";

/** Checkouts asked of Stripe per call: its own most. */
export const SALES_PAGE = 100;
const CURSOR = /^cs_[A-Za-z0-9_]{1,250}$/;

export type SalesPage = { data: Record<string, unknown>[]; next: string | null; refunds_checked: false };

type Row = { id?: unknown; status?: unknown; payment_status?: unknown; mode?: unknown; created?: unknown; payment_intent?: unknown; invoice?: unknown; amount_total?: unknown; currency?: unknown; customer_email?: unknown; customer_details?: unknown; total_details?: unknown; metadata?: Record<string, string> | null };

const str = (value: unknown) => (typeof value === "string" && value ? value : null);
const num = (value: unknown) => (typeof value === "number" && Number.isFinite(value) ? value : 0);
const iso = (seconds: unknown) => (typeof seconds === "number" && seconds > 0 ? new Date(seconds * 1000).toISOString() : null);
const obj = (value: unknown) => (typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : null);

/**
 * When the buyer paid, never when the checkout page opened (the session's own
 * `created`): the charge of a one-time payment, or the payment of the first
 * invoice of a membership or payment plan, both expanded on the same list
 * request. A checkout that charged nothing (a free order) has no payment
 * moment, so null.
 */
export function paidAt(row: { payment_intent?: unknown; invoice?: unknown }): string | null {
  const charge = obj(obj(row.payment_intent)?.latest_charge);
  if (charge) return iso(charge.created);
  return iso(obj(obj(row.invoice)?.status_transitions)?.paid_at);
}

/** What kind of sale a checkout was, as sale.completed says it. */
export function saleKind(row: { mode?: unknown; metadata?: Record<string, string> | null }): string {
  const kind = row.metadata?.kind;
  if (kind === "call") return "call";
  if (kind === "plan") return "payment_plan";
  if (kind === "tip") return "tip";
  return row.mode === "subscription" ? "membership" : "one_time";
}

/** One page of the store's sales, or null when Stripe's answer could not be read whole. */
export async function sales(store: Store, rawCursor: string | null): Promise<SalesPage | null> {
  const cursor = rawCursor && CURSOR.test(rawCursor) ? rawCursor : null;
  const page = await onAccount("GET", store.stripeAccountId as string, `/checkout/sessions?limit=${SALES_PAGE}&expand[]=data.payment_intent.latest_charge&expand[]=data.invoice${cursor ? `&starting_after=${encodeURIComponent(cursor)}` : ""}`);
  // An unreadable list is unknown, never proof of no sales.
  if (typeof page !== "object" || page === null || Array.isArray(page) || !Array.isArray(page.data) || typeof page.has_more !== "boolean" ||
      page.data.some((row: unknown) => typeof row !== "object" || row === null || Array.isArray(row))) return null;
  const rows = page.data as Row[];
  const handles = saleHandles(store);
  const mine = rows.filter((row) => typeof row.id === "string" && isSettled(row) && handles.has(row.metadata?.store ?? ""));
  const ids = [...new Set(mine.map((row) => row.metadata?.product).filter((id): id is string => typeof id === "string" && id !== ""))];
  const titles = new Map((ids.length ? await readListings(store, ids) : []).map((p) => [p.id, p.title]));
  const last = rows.length ? str(rows[rows.length - 1].id) : null;
  return {
    data: mine.map((row) => {
      const meta = row.metadata ?? {};
      const details = (row.customer_details ?? {}) as { email?: unknown; name?: unknown };
      const totals = (row.total_details ?? {}) as { amount_discount?: unknown };
      const product = str(meta.product);
      return {
        checkout_session: row.id,
        kind: saleKind(row),
        product: { id: product, title: str(meta.title) ?? (product ? titles.get(product) ?? null : null) },
        option: str(meta.option),
        amount_cents: num(row.amount_total),
        discount_cents: num(totals.amount_discount),
        // Unknown is null, never a guessed currency.
        currency: str(row.currency),
        buyer: { email: str(details.email) ?? str(row.customer_email), name: str(details.name) },
        paid_at: paidAt(row),
        trial: Number(meta.trial_days) > 0,
        source: sourceOf(meta),
      };
    }),
    next: page.has_more === true && last ? last : null,
    refunds_checked: false,
  };
}
