/**
 * #4802's siblings (coordinator, 15 November 2026): a paid Stripe checkout whose `amount_total` or `currency` does not
 * read was taken as a $0 sale, or one in the store's currency, in the store's sales reading (lib/stats.ts) and in a
 * booking's record (lib/calls.ts). One reader, paidMoneyOf (lib/paid-amount.ts): a safe whole number of minor units,
 * zero or more, and an explicit three-letter code, or null. Unknown is never $0: the sales reading leaves the sale out
 * and says so ("amount"), and a booking keeps its time with no amount, so nothing says it was free. Synthetic Stripe.
 */
import { paidMoneyOf } from "@/lib/paid-amount";
import { readPaidSales, readSales } from "@/lib/stats";
import { paidCall } from "@/lib/calls";
import { claimHandle, ensureStatsId, setStripeAccount, storeForEmail } from "@/lib/store";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";

process.env.NIMBUS_DATA_KEY = "a-local-key-for-tests-only-0123456789abcdef";
process.env.STRIPE_SECRET_KEY = "sk_test_paid_amount_exact_only";
const NOW = Math.floor(Date.now() / 1000);
const paid = (id: string, money: Record<string, unknown>, meta: Record<string, string> = { store: "paidexact", product: "guide000001" }) =>
  ({ id, object: "checkout.session", status: "complete", payment_status: "paid", created: NOW - 3600, ...money, metadata: meta });
let listed: unknown[] = [];
let intents: unknown[] = [];
let refunds: unknown[] = [];
let disputes: unknown[] = [];
let one: unknown = null;

globalThis.fetch = (async (input: string | URL | Request) => {
  const url = new URL(String(input instanceof Request ? input.url : input));
  const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200 });
  if (url.pathname === "/v1/checkout/sessions") return json({ object: "list", data: listed, has_more: false });
  if (url.pathname === "/v1/payment_intents") return json({ object: "list", data: intents, has_more: false });
  if (url.pathname === "/v1/refunds") return json({ object: "list", data: refunds, has_more: false });
  if (url.pathname === "/v1/disputes") return json({ object: "list", data: disputes, has_more: false });
  if (url.pathname.startsWith("/v1/checkout/sessions/")) return json(one);
  return json({ object: "list", data: [], has_more: false });
}) as typeof fetch;

async function main(): Promise<void> {
  redis.clear();

  part("The reader");
  is("a whole amount and a code read; a free checkout's explicit 0 too", [paidMoneyOf({ amount_total: 4900, currency: "usd" }), paidMoneyOf({ amount_total: 0, currency: "eur" })], [{ cents: 4900, currency: "usd" }, { cents: 0, currency: "eur" }]);
  is("anything else is unknown, never $0 or another currency", [
    paidMoneyOf({ currency: "usd" }), paidMoneyOf({ amount_total: null, currency: "usd" }), paidMoneyOf({ amount_total: "4900", currency: "usd" }),
    paidMoneyOf({ amount_total: 49.5, currency: "usd" }), paidMoneyOf({ amount_total: -1, currency: "usd" }), paidMoneyOf({ amount_total: 2 ** 60, currency: "usd" }),
    paidMoneyOf({ amount_total: 4900 }), paidMoneyOf({ amount_total: 4900, currency: "USD" }), paidMoneyOf({ amount_total: 4900, currency: "us" }), paidMoneyOf(null),
  ], [null, null, null, null, null, null, null, null, null, null]);

  await claimHandle("paidexact@example.com", "paidexact", "Paid Exact", "");
  await ensureStatsId("paidexact@example.com");
  await setStripeAccount("paidexact@example.com", "acct_1PaidExactTest01", true);
  const store = (await storeForEmail("paidexact@example.com"))!;

  part("The store's sales reading");
  listed = [paid("cs_test_paidexact0000000001", { amount_total: 1200, currency: "usd" }), paid("cs_test_paidexact0000000002", { amount_total: null, currency: "usd" })];
  const read = await readPaidSales(store, NOW - 86_400, 1);
  is("a sale whose amount does not read is left out, never counted at $0, and the reading says so",
    [read.sales.map((sale) => [sale.cents, sale.currency]), read.partial, read.gaps.includes("amount")], [[[1200, "usd"]], true, true]);

  part("A charge taken in one click after paying (lib/stats.ts, the offers' payments)");
  listed = [paid("cs_test_paidexact0000000001", { amount_total: 1200, currency: "usd" })];
  intents = [{ id: "pi_PaidExactOffer01", object: "payment_intent", status: "succeeded", amount: null, currency: "usd", created: NOW - 3000, metadata: { kind: "upsell", store: "paidexact", product: "guide000002" } }];
  const offers = await readPaidSales(store, NOW - 86_400, 1);
  is("one whose amount does not read is left out, never a $0 sale, and the reading says so",
    [offers.sales.map((sale) => [sale.cents, sale.upsell]), offers.partial, offers.gaps.includes("amount")], [[[1200, false]], true, true]);
  intents = [];

  part("Refunds and disputes whose amount does not read (lib/stats.ts)");
  listed = [];
  refunds = [{ id: "re_PaidExactRefund01", object: "refund", status: "succeeded", amount: null, currency: "usd", created: NOW - 2000, payment_intent: "pi_PaidExact00001" }];
  const withRefund = await readSales(store, NOW * 1000);
  is("a refund of no readable amount is never counted as a $0 refund (and the money reading stays incomplete)",
    [(withRefund?.refundsIn?.d90 ?? []).reduce((n, row) => n + row.refunds, 0), withRefund?.cashflowComplete], [0, false]);
  refunds = [];
  disputes = [{ id: "dp_PaidExactDispute1", object: "dispute", status: "lost", amount: null, currency: "usd", created: NOW - 2000, payment_intent: "pi_PaidExact00002" }];
  is("a dispute lost of no readable amount makes the disputes reading incomplete, never skipped as nothing", (await readSales(store, NOW * 1000))?.disputesComplete, false);
  disputes = [];

  part("A booking's record");
  one = paid("cs_test_paidexactcall000001", { currency: "usd", payment_intent: "pi_PaidExactCall01" }, { store: "paidexact", kind: "call", start: String((NOW + 86_400) * 1000), end: String((NOW + 90_000) * 1000), title: "Coaching" });
  const call = await paidCall(store, "cs_test_paidexactcall000001");
  is("its time kept, its amount unknown (null), never 0 (which reads as a package session, nothing charged)", [call !== null, call?.amount], [true, null]);

  done();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
