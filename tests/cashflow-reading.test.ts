import { readSales, readStats, studioStats } from "@/lib/stats";
import { claimHandle, ensureStatsId, setStripeAccount, storeForEmail } from "@/lib/store";
import { readPayPalRefundsWithCoverage } from "@/lib/paypal-sales";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";

process.env.STRIPE_SECRET_KEY = "sk_test_cashflow_stand_in";
const NOW = Date.parse("2026-10-13T12:00:00Z");
let mode: "complete" | "failed" | "partial" | "unmatched" | "renewal-failed" = "complete";
let refundCalls = 0;
globalThis.fetch = (async (input: string | URL | Request) => {
  const url = new URL(String(input));
  const list = (data: unknown[], hasMore = false) => new Response(JSON.stringify({ data, has_more: hasMore }), { status: 200 });
  if (url.pathname.endsWith("/checkout/sessions")) return list([{
    id: "cs_test_cashflow0001", status: "complete", payment_status: "paid", amount_total: 5000,
    currency: "usd", created: NOW / 1000, payment_intent: "pi_cashflow0001", customer_details: { email: "buyer@example.com" },
    metadata: { store: "cashflow", product: "p1", channel: "instagram" },
  }]);
  if (url.pathname.endsWith("/refunds")) {
    refundCalls++;
    if (mode === "failed") throw Error("refund service unavailable");
    return list([{ id: `re_${refundCalls}`, status: "succeeded", amount: 1000, currency: "usd", created: NOW / 1000,
      payment_intent: mode === "unmatched" ? "pi_other_store" : "pi_cashflow0001" }], mode === "partial");
  }
  if (url.pathname.endsWith("/invoices") && mode === "renewal-failed") throw Error("renewal service unavailable");
  return list([]);
}) as typeof fetch;

async function main() {
  redis.clear();
  const owner = "cashflow-owner@example.com";
  await claimHandle(owner, "cashflow", "Cashflow", "");
  await ensureStatsId(owner);
  await setStripeAccount(owner, "acct_TestCashflow001", true);
  const store = (await storeForEmail(owner))!;
  part("Payment-provider coverage reaches the panel");
  const complete = (await readSales(store, NOW))!;
  is("all payments and matched refunds were read", complete.cashflowComplete, true);
  is("buyer-channel counts are available without personal data", [complete.buyerChannels?.d7.rows[0]?.buyers, /@/.test(JSON.stringify(complete.buyerChannels))], [1, false]);
  const stats = (await readStats(store, NOW))!;
  const panel = studioStats(store, stats, complete, "ok", []);
  is("both new capabilities reach the actual studio data", [panel.cashflowComplete, panel.buyerChannels?.d7.rows[0]?.buyers], [true, 1]);
  mode = "failed";
  const failed = (await readSales(store, NOW))!;
  is("a refund outage is unknown, not no refunds", [failed.cashflowComplete, failed.refundsIn], [false, undefined]);
  mode = "partial";
  refundCalls = 0;
  is("the refund page limit stops a complete-result claim", [(await readSales(store, NOW))!.cashflowComplete, refundCalls], [false, 5]);
  mode = "unmatched";
  is("a refund not linked to this store blocks a complete-result claim", (await readSales(store, NOW))!.cashflowComplete, false);
  mode = "renewal-failed";
  is("a renewal outage does not silently mean zero renewals", (await readSales(store, NOW))!.cashflowComplete, false);
  part("PayPal refund coverage");
  const noRefunds = await readPayPalRefundsWithCoverage(store.statsId, NOW / 1000 - 86400);
  is("a known empty reading is complete", noRefunds, { rows: [], partial: false });
  await redis.pipeline([["ZADD", `nl:ppsell:refunded:${store.statsId}`, NOW / 1000, "missing-order"]]);
  const paypal = await readPayPalRefundsWithCoverage(store.statsId, NOW / 1000 - 86400);
  is("a refund whose payment is missing makes the reading incomplete", paypal, { rows: [], partial: true });
  done();
}
main().catch((error) => { console.error(error); process.exit(1); });
