/**
 * #4386: a paid checkout of the store, or a one-click offer after paying, whose amount Stripe answers missing, null,
 * fractional, negative or past a safe integer is never counted as a sale of $0. The sales reading leaves it out, is
 * partial and names the gap "amount" (lib/stats.ts readPaidSales). An explicit 0 is a real amount and is kept.
 *
 * Stripe is a stand-in for fetch; synthetic store, in-memory Redis.
 */
import { readPaidSales } from "@/lib/stats";
import { claimHandle, ensureStatsId, setStripeAccount, storeForEmail } from "@/lib/store";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";

process.env.STRIPE_SECRET_KEY = "sk_test_sales_amount_stand_in";
const NOW = Date.parse("2026-10-13T12:00:00Z");
let checkoutAmount: unknown = 5000;
let upsellAmount: unknown = 1500;
globalThis.fetch = (async (input: string | URL | Request) => {
  const url = new URL(String(input));
  const list = (data: unknown[]) => new Response(JSON.stringify({ object: "list", data, has_more: false }), { status: 200 });
  if (url.pathname.endsWith("/checkout/sessions")) return list([{
    id: "cs_test_amount000001", status: "complete", payment_status: "paid", amount_total: checkoutAmount,
    currency: "usd", created: NOW / 1000, payment_intent: "pi_amount000001", customer_details: { email: "buyer@example.com" },
    metadata: { store: "amounts", product: "p1" },
  }]);
  if (url.pathname.endsWith("/payment_intents")) return list([{
    id: "pi_upsell000001", status: "succeeded", amount: upsellAmount, currency: "usd", created: NOW / 1000,
    metadata: { kind: "upsell", store: "amounts", product: "p2" },
  }]);
  return list([]);
}) as typeof fetch;

async function main(): Promise<void> {
  redis.clear();
  const owner = "amounts-owner@example.com";
  await claimHandle(owner, "amounts", "Amounts", "");
  await ensureStatsId(owner);
  await setStripeAccount(owner, "acct_TestAmounts0001", true);
  const store = (await storeForEmail(owner))!;
  const since = Math.floor(NOW / 1000) - 86_400;
  const read = async () => {
    const r = await readPaidSales(store, since, 1);
    return { partial: r.partial, gaps: r.gaps, cents: r.sales.map((s) => [s.upsell ? "upsell" : "checkout", s.cents]) };
  };

  part("Whole amounts, an explicit 0 among them, are kept");
  is("both sales, whole", await read(), { partial: false, gaps: [], cents: [["checkout", 5000], ["upsell", 1500]] });
  checkoutAmount = 0;
  is("an explicit 0 is a real amount", (await read()).cents, [["checkout", 0], ["upsell", 1500]]);

  part("A checkout's amount that does not read is never a sale of $0");
  for (const bad of [undefined, null, 49.5, -100, Number.MAX_SAFE_INTEGER + 1, "5000"]) {
    checkoutAmount = bad;
    is(`amount_total ${JSON.stringify(bad) ?? "missing"}: left out, partial, gap "amount"`, await read(), { partial: true, gaps: ["amount"], cents: [["upsell", 1500]] });
  }
  checkoutAmount = 5000;

  part("Nor an offer's after paying");
  for (const bad of [undefined, null, 12.25]) {
    upsellAmount = bad;
    is(`amount ${JSON.stringify(bad) ?? "missing"}: left out, partial, gap "amount"`, await read(), { partial: true, gaps: ["amount"], cents: [["checkout", 5000]] });
  }

  done();
}

main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
