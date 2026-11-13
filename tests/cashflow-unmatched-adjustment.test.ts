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
import { readSales } from "@/lib/stats";
import { claimHandle, ensureStatsId, setStripeAccount, storeForEmail } from "@/lib/store";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";

process.env.STRIPE_SECRET_KEY = "sk_test_cashflow_stand_in";
const NOW = Date.parse("2026-10-13T12:00:00Z");
let sessions: unknown[] = [];
let refunds: unknown[] = [];
let disputes: unknown[] = [];
globalThis.fetch = (async (input: string | URL | Request) => {
  const url = new URL(String(input));
  const list = (data: unknown[]) => new Response(JSON.stringify({ object: "list", data, has_more: false }), { status: 200 });
  if (url.pathname.endsWith("/checkout/sessions")) return list(sessions);
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

  done();
}

main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
