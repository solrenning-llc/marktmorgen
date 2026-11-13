// X8-2325 (#4376): a refund or dispute on a payment that is not among the
// store's own payments read cannot be taken off the store's kept total as a
// known figure: its origin is not confirmed, so the kept total is unknown.
import { readSales, type SalesStats } from "@/lib/stats";
import { claimHandle, ensureStatsId, setStripeAccount, storeForEmail } from "@/lib/store";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";

process.env.STRIPE_SECRET_KEY = "sk_test_cashflow_stand_in";
const NOW = Date.parse("2026-10-13T12:00:00Z");
let sessions: unknown[] = [];
let invoices: unknown[] = [];
let refunds: unknown[] = [];
let disputes: unknown[] = [];
globalThis.fetch = (async (input: string | URL | Request) => {
  const url = new URL(String(input));
  const list = (data: unknown[]) => new Response(JSON.stringify({ object: "list", data, has_more: false }), { status: 200 });
  if (url.pathname.endsWith("/checkout/sessions")) return list(sessions);
  if (url.pathname.endsWith("/invoices")) return list(url.searchParams.get("status") === "paid" ? invoices : []);
  if (url.pathname.endsWith("/refunds")) return list(refunds);
  if (url.pathname.endsWith("/disputes")) return list(disputes);
  return list([]);
}) as typeof fetch;
const sale = (pi: string, cents: number) => ({
  id: `cs_test_${pi}00000000`, status: "complete", payment_status: "paid", amount_total: cents,
  currency: "usd", created: NOW / 1000, payment_intent: pi, customer_details: { email: "buyer@example.com" },
  metadata: { store: "cashflow", product: "p1", channel: "instagram" },
});
const refund = (pi: string, cents: number) => ({ id: `re_${pi}`, object: "refund", status: "succeeded", amount: cents, currency: "usd", created: NOW / 1000, payment_intent: pi });
const dispute = (pi: string, cents: number) => ({ id: `dp_${pi}`, object: "dispute", status: "lost", amount: cents, currency: "usd", created: NOW / 1000, payment_intent: pi });

async function main() {
  redis.clear();
  const owner = "cashflow-owner@example.com";
  await claimHandle(owner, "cashflow", "Cashflow", "");
  await ensureStatsId(owner);
  await setStripeAccount(owner, "acct_TestCashflow001", true);
  const store = (await storeForEmail(owner))!;
  const usd = (r: SalesStats) => r.keptIn?.d7.lines.find((row) => row.currency === "usd");

  part("An adjustment to a payment that is not the store's cannot certify the store's kept total");
  sessions = [sale("pi_store", 5000)];
  const control = (await readSales(store, NOW))!;
  is("control: $50 kept", usd(control)?.keptCents, 5000);
  refunds = [refund("pi_store", 1000)];
  const own = (await readSales(store, NOW))!;
  is("a $10 refund of the store's own sale: $40 kept, known", [usd(own)?.keptCents, usd(own)?.missing], [4000, []]);
  refunds = [refund("pi_payment_link_external", 2000)];
  const external = (await readSales(store, NOW))!;
  is("an unmatched $20 refund: the kept total is not certified", [usd(external)?.keptCents, usd(external)?.missing], [null, ["refunds"]]);
  refunds = [];
  disputes = [dispute("pi_payment_link_external", 2000)];
  const extDispute = (await readSales(store, NOW))!;
  is("an unmatched $20 lost dispute: the kept total is not certified", [usd(extDispute)?.keptCents, usd(extDispute)?.missing], [null, ["disputes"]]);
  disputes = [dispute("pi_store", 2000)];
  const ownDispute = (await readSales(store, NOW))!;
  is("a lost $20 dispute on the store's own sale: $30 kept, known", usd(ownDispute)?.keptCents, 3000);

  part("A refund of a store renewal whose invoice names its payment stays a known deduction");
  disputes = [];
  sessions = [];
  invoices = [{ id: "in_renew_1", object: "invoice", status: "paid", billing_reason: "subscription_cycle", amount_paid: 5000, currency: "usd",
    created: NOW / 1000 - 3600, payment_intent: "pi_renewal", subscription_details: { metadata: { store: "cashflow", product: "club", channel: "newsletter" } } }];
  refunds = [refund("pi_renewal", 1000)];
  const renewal = (await readSales(store, NOW))!;
  is("the renewal refund: $40 kept, known", usd(renewal)?.keptCents, 4000);
  invoices = [{ id: "in_other", object: "invoice", status: "paid", billing_reason: "subscription_cycle", amount_paid: 5000, currency: "usd",
    created: NOW / 1000 - 3600, payment_intent: "pi_other_store_renewal", subscription_details: { metadata: { store: "someone-else", product: "club" } } }];
  refunds = [refund("pi_other_store_renewal", 1000)];
  const otherRenewal = (await readSales(store, NOW))!;
  is("a refund of another store's renewal is not confirmed as this store's", usd(otherRenewal)?.keptCents, null);
  done();
}
main().catch((error) => { console.error(error); process.exit(1); });
