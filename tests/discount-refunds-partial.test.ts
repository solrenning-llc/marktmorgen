/**
 * #4372 (Codex X8, transcribed by Claude 2): the discount table's Refunded
 * column is offered only when the refunds were read whole. A refunds reading
 * that stopped at its page limit (partial) may have missed the refund of a
 * discounted sale, so the column is left out rather than shown as 0%; a whole
 * reading, even an empty one, still shows it. Synthetic Stripe answers only.
 */
import { readSales } from "@/lib/stats";
import { claimHandle, ensureStatsId, setStripeAccount, storeForEmail } from "@/lib/store";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";

process.env.STRIPE_SECRET_KEY = "sk_test_cashflow_stand_in";
const NOW = Date.parse("2026-10-13T12:00:00Z");
let refundsPartial = false;
globalThis.fetch = (async (input: string | URL | Request) => {
  const url = new URL(String(input));
  const list = (data: unknown[], hasMore = false) => new Response(JSON.stringify({ data, has_more: hasMore }), { status: 200 });
  if (url.pathname.endsWith("/checkout/sessions")) return list([{
    id: "cs_test_cashflow0001", status: "complete", payment_status: "paid", amount_total: 5000, total_details: { amount_discount: 1000 },
    currency: "usd", created: NOW / 1000, payment_intent: "pi_cashflow0001", customer_details: { email: "buyer@example.com" },
    metadata: { store: "cashflow", product: "p1", channel: "instagram", coupon: "SAVE10" },
  }]);
  if (url.pathname.endsWith("/refunds")) return refundsPartial
    ? list([{ id: `re_${Math.random().toString(36).slice(2)}`, status: "succeeded", amount: 100, currency: "usd", created: NOW / 1000, payment_intent: "pi_elsewhere" }], true)
    : list([]);
  return list([]);
}) as typeof fetch;

async function main() {
  redis.clear();
  const owner = "cashflow-owner@example.com";
  await claimHandle(owner, "cashflow", "Cashflow", "");
  await ensureStatsId(owner);
  await setStripeAccount(owner, "acct_TestCashflow001", true);
  const store = (await storeForEmail(owner))!;

  part("The discount table's Refunded column");
  refundsPartial = false;
  const whole = (await readSales(store, NOW))!;
  is("control: a discounted sale row, refunds read whole (empty)", [Boolean(whole.discounts?.rows?.length), whole.discounts?.refundsRead], [true, true]);
  refundsPartial = true;
  const cut = (await readSales(store, NOW))!;
  is("control: the refund reading is partial", cut.cashflowComplete, false);
  is("Refunded is not offered while a refund page was missed", cut.discounts?.refundsRead, false);
  is("the table itself stays", Boolean(cut.discounts?.rows?.length), true);
  done();
}
main().catch((error) => { console.error(error); process.exit(1); });
