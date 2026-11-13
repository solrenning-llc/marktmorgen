/**
 * #4369 (Codex X8, transcribed by Claude 2): a refund Stripe has not paid out
 * yet (pending, for example waiting for balance) is not money given back. Only
 * a succeeded refund is confirmed cash out; pending and requires_action are
 * none yet, and the reading stays complete. Synthetic Stripe answers only.
 */
import { readSales } from "@/lib/stats";
import { claimHandle, ensureStatsId, setStripeAccount, storeForEmail } from "@/lib/store";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";

process.env.STRIPE_SECRET_KEY = "sk_test_cashflow_stand_in";
const NOW = Date.parse("2026-10-13T12:00:00Z");
let refund: Record<string, unknown> = {};
globalThis.fetch = (async (input: string | URL | Request) => {
  const url = new URL(String(input));
  const list = (data: unknown[], hasMore = false) => new Response(JSON.stringify({ data, has_more: hasMore }), { status: 200 });
  if (url.pathname.endsWith("/checkout/sessions")) return list([{
    id: "cs_test_cashflow0001", status: "complete", payment_status: "paid", amount_total: 5000,
    currency: "usd", created: NOW / 1000, payment_intent: "pi_cashflow0001", customer_details: { email: "buyer@example.com" },
    metadata: { store: "cashflow", product: "p1", channel: "instagram" },
  }]);
  if (url.pathname.endsWith("/refunds")) return list([{ id: "re_1", currency: "usd", created: NOW / 1000, payment_intent: "pi_cashflow0001", ...refund }]);
  return list([]);
}) as typeof fetch;

async function main() {
  redis.clear();
  const owner = "cashflow-owner@example.com";
  await claimHandle(owner, "cashflow", "Cashflow", "");
  await ensureStatsId(owner);
  await setStripeAccount(owner, "acct_TestCashflow001", true);
  const store = (await storeForEmail(owner))!;
  type Read = Awaited<ReturnType<typeof readSales>>;
  const out7 = (r: Read) => ((r as unknown as { refundsIn?: { d7?: { cents: number }[] } })?.refundsIn?.d7 ?? []).reduce((s, row) => s + row.cents, 0);

  part("A pending refund is not money given back yet");
  refund = { status: "succeeded", amount: 1000 };
  const ok = (await readSales(store, NOW))!;
  is("control: a succeeded $10 refund is $10 out, complete", [out7(ok), ok.cashflowComplete], [1000, true]);
  for (const status of ["pending", "requires_action"]) {
    refund = { status, amount: 1000 };
    const waiting = (await readSales(store, NOW))!;
    is(`a ${status} refund is no confirmed cash out, and the reading stays complete`, [out7(waiting), waiting.cashflowComplete], [0, true]);
  }
  done();
}
main().catch((error) => { console.error(error); process.exit(1); });
