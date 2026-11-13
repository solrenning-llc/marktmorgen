/**
 * #4376: a refund or dispute on a payment that is not one of the store's
 * sales read (for example a payment link made outside Marktmorgen on the same
 * Stripe account) never certifies the store's kept total. It may still be
 * shown as unrecorded, but the reading it belongs to is incomplete, so the
 * kept total is not a known value (rule 24). A refund or dispute of a store
 * sale that was read keeps lowering it exactly.
 *
 * Stripe is played by a stand-in for fetch; synthetic store, in-memory Redis.
 */
import { KEPT_MATCH_LOOKUPS, readSales } from "@/lib/stats";
import { SALES_READ_SHAPE } from "@/lib/read-ceilings";
import { HEAVY_READINGS_PER_DAY } from "@/lib/store-readings";
import { PRICES_WITHOUT_COMMISSION } from "@/lib/plan";
import { paidStorageBytes } from "@/lib/storage-rules";
import { CLOSING_DAYS, WARN_WEEK_DAYS } from "@/lib/plan-closing-rules";
import { GB, STORAGE_PER_GB, providerFeeUsd, worstCost } from "./plan-cost-model";
import { claimHandle, ensureStatsId, setStripeAccount, storeForEmail } from "@/lib/store";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";

process.env.STRIPE_SECRET_KEY = "sk_test_cashflow_stand_in";
const NOW = Date.parse("2026-10-13T12:00:00Z");
let sessions: unknown[] = [];
let refunds: unknown[] = [];
let disputes: unknown[] = [];
let invoices: unknown[] = [];
/** Stripe's invoice payments, by payment intent: the invoice it paid, or "bad" for a reply in another shape. */
let invoicePayments: Record<string, string> = {};
let lookups = 0;
globalThis.fetch = (async (input: string | URL | Request) => {
  const url = new URL(String(input));
  const list = (data: unknown[]) => new Response(JSON.stringify({ object: "list", data, has_more: false }), { status: 200 });
  if (url.pathname.endsWith("/checkout/sessions")) return list(sessions);
  if (url.pathname.endsWith("/invoices")) return list(url.searchParams.get("status") === "paid" ? invoices : []);
  if (url.pathname.endsWith("/invoice_payments")) {
    lookups += 1;
    const invoice = invoicePayments[url.searchParams.get("payment[payment_intent]") ?? ""];
    if (invoice === "bad") return new Response(JSON.stringify({ object: "invoice_payment" }), { status: 200 });
    return list(invoice ? [{ object: "invoice_payment", invoice }] : []);
  }
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

async function main(): Promise<void> {
  redis.clear();
  const owner = "cashflow-owner@example.com";
  await claimHandle(owner, "cashflow", "Cashflow", "");
  await ensureStatsId(owner);
  await setStripeAccount(owner, "acct_TestCashflow001", true);
  const store = (await storeForEmail(owner))!;
  type Line = { currency: string; keptCents: number | null };
  const usd = async () => ((await readSales(store, NOW))?.keptIn?.d7?.lines as Line[] | undefined)?.find((row) => row.currency === "usd")?.keptCents;
  sessions = [sale("pi_store", 5000)];

  part("A store sale, and its own adjustments");
  refunds = [];
  disputes = [];
  is("control: $50 kept", await usd(), 5000);
  refunds = [refund("pi_store", 2000)];
  is("a $20 refund of that sale: $30 kept, as a known value", await usd(), 3000);
  refunds = [];
  disputes = [dispute("pi_store", 2000)];
  is("a $20 lost dispute of that sale: $30 kept, as a known value", await usd(), 3000);

  part("An adjustment to a payment that is not a store sale read");
  disputes = [];
  refunds = [refund("pi_payment_link_external", 2000)];
  is("an unmatched $20 refund: the kept total is not certified", await usd(), null);
  refunds = [];
  disputes = [dispute("pi_payment_link_external", 2000)];
  is("an unmatched $20 lost dispute: the kept total is not certified", await usd(), null);

  // A guard for the fix: a refund of the store's own renewal is the store's.
  // It lowers the kept total exactly, and does not make it unknown.
  part("A refund of the store's own renewal");
  sessions = [];
  disputes = [];
  invoices = [{
    id: "in_renew_1", object: "invoice", status: "paid", billing_reason: "subscription_cycle", amount_paid: 5000, currency: "usd",
    created: NOW / 1000 - 3600, payment_intent: "pi_renewal", subscription_details: { metadata: { store: "cashflow", product: "club", channel: "newsletter" } },
  }];
  refunds = [];
  is("control: the $50 renewal kept", await usd(), 5000);
  refunds = [refund("pi_renewal", 1000)];
  is("a $10 refund of it: $40 kept, as a known value", await usd(), 4000);

  part("A renewal whose invoice does not name its payment: looked up, at most KEPT_MATCH_LOOKUPS");
  invoices = [{
    id: "in_Renew0002", object: "invoice", status: "paid", billing_reason: "subscription_cycle", amount_paid: 5000, currency: "usd",
    created: NOW / 1000 - 3600, subscription_details: { metadata: { store: "cashflow", product: "club", channel: "newsletter" } },
  }];
  invoicePayments = { pi_renewal2: "in_Renew0002" };
  refunds = [refund("pi_renewal2", 1000)];
  lookups = 0;
  is("found by one lookup: $40 kept, as a known value", [await usd(), lookups], [4000, 1]);
  invoicePayments = { pi_renewal2: "bad" };
  lookups = 0;
  is("a lookup that does not read: the kept total is not known", [await usd(), lookups], [null, 1]);
  invoicePayments = { pi_renewal2: "in_SomeoneElse1" };
  is("a payment of another invoice: not the store's, not known", await usd(), null);
  invoicePayments = Object.fromEntries(Array.from({ length: KEPT_MATCH_LOOKUPS + 1 }, (_, i) => [`pi_more${i}`, "in_Renew0002"]));
  refunds = Object.keys(invoicePayments).map((pi) => ({ ...refund(pi, 100), id: `re_${pi}` }));
  lookups = 0;
  is(`more than ${KEPT_MATCH_LOOKUPS} to look up: none is looked up, and the kept total is not known`, [await usd(), lookups], [null, 0]);
  invoicePayments = Object.fromEntries(Array.from({ length: KEPT_MATCH_LOOKUPS }, (_, i) => [`pi_more${i}`, "in_Renew0002"]));
  refunds = Object.keys(invoicePayments).map((pi) => ({ ...refund(pi, 100), id: `re_${pi}` }));
  lookups = 0;
  is(`exactly ${KEPT_MATCH_LOOKUPS}: each looked up once, and the total is known`, [await usd(), lookups], [5000 - 100 * KEPT_MATCH_LOOKUPS, KEPT_MATCH_LOOKUPS]);

  part("What the lookups cost, against the owner's $65 ceiling");
  // The sales reading's pages: 2 x 20 sales, 10 renewals, 5 refunds, 3 disputes, and the lookups.
  is("the sales reading is priced at its Stripe pages and its lookups: 63", [KEPT_MATCH_LOOKUPS, SALES_READ_SHAPE.stripePages], [5, 2 * 20 + 10 + 5 + 3 + 5]);
  const keptToClosing = (paidStorageBytes("creator") / GB) * STORAGE_PER_GB * ((CLOSING_DAYS + WARN_WEEK_DAYS) / 30);
  const year = worstCost("creator") + providerFeeUsd(PRICES_WITHOUT_COMMISSION.creator.year) + keptToClosing;
  is(`the first year given back stays under $65 with them (${year.toFixed(4)}; ${(65 - year).toFixed(4)} left, which any new heavy read must look at first)`, [year < 65, HEAVY_READINGS_PER_DAY], [true, 2]);

  done();
}

main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
