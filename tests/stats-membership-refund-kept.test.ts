/**
 * RED for #4549 (#4376 fix; Claude 1 cloud R's MEDIUM): a refund of the store's own membership payment, in the shape a
 * current Stripe API version lists it (an invoice with no `payment_intent` field and no embedded `payments` unless
 * expanded; a subscription checkout with `payment_intent: null`), is the store's: the account's invoice payments prove
 * it. It stays a known deduction, as on main, and never makes the kept total unknown. Synthetic store, Stripe answered here.
 */
import { readSales, type SalesStats } from "@/lib/stats";
import { claimHandle, ensureStatsId, setStripeAccount, storeForEmail } from "@/lib/store";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";

process.env.STRIPE_SECRET_KEY = "sk_test_cashflow_stand_in";
const NOW = Date.parse("2026-10-13T12:00:00Z");
let sessions: unknown[] = [];
let invoices: unknown[] = [];
let refunds: unknown[] = [];
let invoicePayments: unknown[] = [];
globalThis.fetch = (async (input: string | URL | Request) => {
  const url = new URL(String(input));
  const list = (data: unknown[]) => new Response(JSON.stringify({ object: "list", data, has_more: false }), { status: 200 });
  if (url.pathname.endsWith("/checkout/sessions")) return list(sessions);
  if (url.pathname.endsWith("/invoices")) return list(url.searchParams.get("status") === "paid" ? invoices : []);
  if (url.pathname.endsWith("/invoice_payments")) {
    const intent = url.searchParams.get("payment[payment_intent]");
    if (!intent) return list(invoicePayments);
    // The lookup by one payment (#4549) lists that payment's allocations with each invoice expanded, as Stripe does.
    const rows = (invoicePayments as { invoice?: unknown; payment?: { payment_intent?: string } }[]).filter((row) => row.payment?.payment_intent === intent);
    return list(rows.map((row) => ({ ...row, invoice: invoiceOf(String(row.invoice)) })));
  }
  if (url.pathname.endsWith("/refunds")) return list(refunds);
  return list([]);
}) as typeof fetch;
/** A store invoice by id: a listed renewal, or the first invoice a membership's checkout opened. */
const invoiceOf = (id: string): unknown => (invoices as { id?: string }[]).find((invoice) => invoice.id === id) ?? (id === "in_first_member" ? {
  id, object: "invoice", status: "paid", billing_reason: "subscription_create", amount_paid: 5000, currency: "usd", created: NOW / 1000 - 3600,
  parent: { subscription_details: { metadata: { store: "cashflow", product: "club", channel: "instagram" } } } } : id);
const refund = (pi: string, cents: number) => ({ id: `re_${pi}`, object: "refund", status: "succeeded", amount: cents, currency: "usd", created: NOW / 1000, payment_intent: pi });

async function main() {
  redis.clear();
  const owner = "cashflow-owner@example.com";
  await claimHandle(owner, "cashflow", "Cashflow", "");
  await ensureStatsId(owner);
  await setStripeAccount(owner, "acct_TestCashflow001", true);
  const store = (await storeForEmail(owner))!;
  const usd = (r: SalesStats) => r.keptIn?.d7.lines.find((row) => row.currency === "usd");

  part("A renewal in the current API's shape (no payment_intent, payments not expanded)");
  invoices = [{ id: "in_renew_new", object: "invoice", status: "paid", billing_reason: "subscription_cycle", amount_paid: 5000, currency: "usd",
    created: NOW / 1000 - 3600, parent: { subscription_details: { metadata: { store: "cashflow", product: "club", channel: "newsletter" } } } }];
  invoicePayments = [{ id: "inpay_1", object: "invoice_payment", invoice: "in_renew_new", status: "paid", payment: { type: "payment_intent", payment_intent: "pi_renewalnew0001" } }];
  refunds = [refund("pi_renewalnew0001", 1000)];
  const renewal = (await readSales(store, NOW))!;
  is("a $10 refund of the store's own renewal: $40 kept, known", usd(renewal)?.keptCents, 4000);

  part("A membership's first payment through checkout (payment_intent null, paid by its invoice)");
  invoices = [];
  sessions = [{ id: "cs_test_member0000001", mode: "subscription", status: "complete", payment_status: "paid", amount_total: 5000, currency: "usd",
    created: NOW / 1000 - 3600, payment_intent: null, invoice: "in_first_member", customer_details: { email: "member@example.com" },
    metadata: { store: "cashflow", product: "club", channel: "instagram" } }];
  invoicePayments = [{ id: "inpay_2", object: "invoice_payment", invoice: "in_first_member", status: "paid", payment: { type: "payment_intent", payment_intent: "pi_firstmember001" } }];
  refunds = [refund("pi_firstmember001", 1000)];
  const first = (await readSales(store, NOW))!;
  is("a $10 refund of the membership's first payment: $40 kept, known", usd(first)?.keptCents, 4000);
  done();
}
main().catch((error) => { console.error(error); process.exit(1); });
