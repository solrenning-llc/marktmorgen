/**
 * Issue #4726 (Codex X8, money, MEDIUM): a store whose refund reading was partial reached the store comparison with a
 * 0% refund rate, because studioStats handed sampleFrom the rows it had (none) without saying they were incomplete.
 * The refund reading's own coverage now travels with them (SalesStats.refundsComplete, StatsData.refundsComplete), and
 * sampleFrom leaves out only the refund rate when it is not known complete, a studio copy from before the fix too
 * (rule 24: unknown is never 0%). A complete empty reading is still 0%; sales, conversion and returning buyers stay.
 * Synthetic Stripe, in-memory Redis.
 */
import { readSales, readStats, studioStats, type StatsData } from "@/lib/stats";
import { sampleFrom } from "@/lib/benchmark-rules";
import { claimHandle, ensureStatsId, setStripeAccount, storeForEmail } from "@/lib/store";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";

process.env.STRIPE_SECRET_KEY = "sk_test_c7_4726";
const NOW = Date.parse("2026-10-13T12:00:00Z");
globalThis.fetch = (async (input: string | URL | Request) => {
  const url = new URL(String(input instanceof Request ? input.url : input));
  const list = (data: unknown[]) => new Response(JSON.stringify({ object: "list", data, has_more: false }), { status: 200 });
  if (url.pathname.endsWith("/checkout/sessions")) return list([{
    id: "cs_test_c74726_0001", object: "checkout.session", status: "complete", payment_status: "paid", amount_total: 5000,
    currency: "usd", created: NOW / 1000, payment_intent: "pi_C74726Sale01", customer_details: { email: "buyer@example.com" },
    metadata: { store: "c7refunds", product: "p1" },
  }]);
  return list([]);
}) as typeof fetch;

/** The studio panel with the 90-day totals of a store with 20 sales out of 1,000 visitors and 50 checkouts. */
const withTotals = (panel: StatsData): StatsData => ({
  ...panel,
  sales: "ok",
  partial: false,
  totals: { ...panel.totals, d90: { ...panel.totals.d90, visitors: 1000, views: 2000, checkouts: 50, sales: 20, cents: 40000 } },
});

async function main(): Promise<void> {
  redis.clear();
  const owner = "c7-4726@example.com";
  await claimHandle(owner, "c7refunds", "C7 Refunds", "");
  await ensureStatsId(owner);
  await setStripeAccount(owner, "acct_TestC74726xx1", true);
  const store = (await storeForEmail(owner))!;

  part("A complete reading with no refund is still 0%");
  const whole = (await readSales(store, NOW))!;
  is("the refunds were read in full", whole.refundsComplete, true);
  const wholePanel = studioStats(store, (await readStats(store, NOW))!, whole, "ok", []);
  is("the panel carries it", wholePanel.refundsComplete, true);
  const wholeSample = sampleFrom(withTotals(wholePanel));
  is("0% refunded, and the other rates stay", [wholeSample?.refunded, wholeSample?.converted, wholeSample?.paid], [0, 0.02, 0.4]);

  part("A partial refund reading with no rows (the issue's case)");
  // A PayPal refund record whose payment is missing: PayPal's refund list is partial, and it has no rows.
  await redis.pipeline([["ZADD", `nl:ppsell:refunded:${store.statsId}`, NOW / 1000, "missing-order"]]);
  const sales = (await readSales(store, NOW))!;
  is("the cash-flow reading and the refund reading say they are not complete", [sales.cashflowComplete, sales.refundsComplete], [false, false]);
  const panel = studioStats(store, (await readStats(store, NOW))!, sales, "ok", []);
  is("the panel carries it", panel.refundsComplete, false);
  const sample = sampleFrom(withTotals(panel));
  is("no refund rate, never 0%; sales and conversion stay", [sample?.refunded, sample?.converted, sample?.paid], [undefined, 0.02, 0.4]);

  part("A studio copy from before the fix, with refund rows and no coverage said");
  const old = withTotals({ ...wholePanel, refunds: { d7: [], d30: [], d90: [] } });
  delete (old as { refundsComplete?: boolean }).refundsComplete;
  is("unknown coverage gives no refund rate", sampleFrom(old)?.refunded, undefined);
  is("nor does a copy whose rows are missing", sampleFrom({ ...withTotals(wholePanel), refunds: null })?.refunded, undefined);

  done();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
