/**
 * Claude 5 on #4549 (MEDIUM, money, rule 30): the account's invoice payments, read in bulk before the one-by-one
 * lookups, confirmed a payment as the store's as soon as one invoice it paid was the store's, even when the same answer
 * listed it paying another invoice too, or when the answer was cut short (partial) and its other invoices may be among
 * those not read. A payment that paid more than one invoice does not say which one a refund gives back (Codex X7), so
 * such a refund leaves the kept total unknown, never reduced on a guess. Synthetic store, Stripe answered here.
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
let invoicePayments: Record<string, unknown>[] = [];
/** The bulk read answers page after page with more behind each (partial), and the one-by-one lookup says more too. */
let endless = false;
let page = 0;
globalThis.fetch = (async (input: string | URL | Request) => {
  const url = new URL(String(input));
  const list = (data: unknown[], more = false) => new Response(JSON.stringify({ object: "list", data, has_more: more }), { status: 200 });
  if (url.pathname.endsWith("/checkout/sessions")) return list(sessions);
  if (url.pathname.endsWith("/invoices")) return list(url.searchParams.get("status") === "paid" ? invoices : []);
  if (url.pathname.endsWith("/invoice_payments")) {
    const intent = url.searchParams.get("payment[payment_intent]");
    if (intent) {
      // The one-by-one lookup answers honestly: every invoice payment of that intent, one at a time.
      const rows = invoicePayments.filter((row) => (row.payment as { payment_intent?: string }).payment_intent === intent);
      return list(rows.slice(0, 1), endless || rows.length > 1);
    }
    if (!endless) return list(invoicePayments);
    page += 1;
    return list(page === 1 ? invoicePayments : [{ id: `inpay_more${page}`, object: "invoice_payment", invoice: `in_other${page}`, status: "paid", payment: { type: "payment_intent", payment_intent: `pi_other${page}000` } }], true);
  }
  if (url.pathname.endsWith("/refunds")) return list(refunds);
  return list([]);
}) as typeof fetch;
const refund = (pi: string, cents: number) => ({ id: `re_${pi}`, object: "refund", status: "succeeded", amount: cents, currency: "usd", created: NOW / 1000, payment_intent: pi });
const pay = (id: string, invoice: string, pi: string) => ({ id, object: "invoice_payment", invoice, status: "paid", payment: { type: "payment_intent", payment_intent: pi } });

async function main() {
  redis.clear();
  const owner = "cashflow-owner@example.com";
  await claimHandle(owner, "cashflow", "Cashflow", "");
  await ensureStatsId(owner);
  await setStripeAccount(owner, "acct_TestCashflow001", true);
  const store = (await storeForEmail(owner))!;
  const usd = (r: SalesStats) => r.keptIn?.d7.lines.find((row) => row.currency === "usd");
  const renewal = { id: "in_renew_new", object: "invoice", status: "paid", billing_reason: "subscription_cycle", amount_paid: 5000, currency: "usd",
    created: NOW / 1000 - 3600, parent: { subscription_details: { metadata: { store: "cashflow", product: "club", channel: "newsletter" } } } };

  part("Control: the payment paid only the store's renewal");
  invoices = [renewal];
  invoicePayments = [pay("inpay_1", "in_renew_new", "pi_sharedintent01")];
  refunds = [refund("pi_sharedintent01", 1000)];
  is("control: $40 kept, known", usd((await readSales(store, NOW))!)?.keptCents, 4000);

  part("The same payment also paid an invoice that is not the store's (listed in the same answer)");
  invoicePayments = [pay("inpay_1", "in_renew_new", "pi_sharedintent01"), pay("inpay_2", "in_payment_link_x", "pi_sharedintent01")];
  is("a refund of a payment that also paid another invoice: kept unknown", usd((await readSales(store, NOW))!)?.keptCents ?? null, null);

  part("Checkout: the membership's first invoice shares its payment with another invoice");
  invoices = [];
  sessions = [{ id: "cs_test_member0000001", mode: "subscription", status: "complete", payment_status: "paid", amount_total: 5000, currency: "usd",
    created: NOW / 1000 - 3600, payment_intent: null, invoice: "in_first_member", customer_details: { email: "member@example.com" },
    metadata: { store: "cashflow", product: "club", channel: "instagram" } }];
  invoicePayments = [pay("inpay_3", "in_first_member", "pi_firstmember001"), pay("inpay_4", "in_payment_link_y", "pi_firstmember001")];
  refunds = [refund("pi_firstmember001", 1000)];
  is("checkout: a refund of a payment that also paid another invoice: kept unknown", usd((await readSales(store, NOW))!)?.keptCents ?? null, null);

  part("The bulk read cut short: its other invoices may be among those not read");
  sessions = [];
  invoices = [renewal];
  invoicePayments = [pay("inpay_1", "in_renew_new", "pi_sharedintent01")];
  refunds = [refund("pi_sharedintent01", 1000)];
  endless = true;
  page = 0;
  is("a partial bulk read confirms nothing; the lookup that says more confirms nothing either: kept unknown", usd((await readSales(store, NOW))!)?.keptCents ?? null, null);
  endless = false;
  is("read whole again: $40 kept, known", usd((await readSales(store, NOW))!)?.keptCents, 4000);
  done();
}
main().catch((error) => { console.error(error); process.exit(1); });
