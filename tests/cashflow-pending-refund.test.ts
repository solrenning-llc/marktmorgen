// A refund Stripe still holds as `pending` (for example, waiting for balance) is not money given back yet:
// the cash-flow panels, the money each channel kept and the discounts' refund rate count only refunds
// that succeeded (issue #4369, Codex X8-2308). Readers that take refunds off sales to be careful
// (lib/path-facts.ts, lib/segments.ts) still see it, so nothing there counts money that may go back.
import { readSales, readStoreRefunds } from "@/lib/stats";
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

type Read = NonNullable<Awaited<ReturnType<typeof readSales>>>;
const out7 = (r: Read) => (r as unknown as { refundsIn?: { d7?: { cents: number }[] } }).refundsIn?.d7?.reduce((s, row) => s + row.cents, 0);
const keptRefunds = (r: Read) => r.keptIn?.d7.lines.reduce((s, row) => s + row.refundCents, 0);

async function main() {
  redis.clear();
  const owner = "cashflow-owner@example.com";
  await claimHandle(owner, "cashflow", "Cashflow", "");
  await ensureStatsId(owner);
  await setStripeAccount(owner, "acct_TestCashflow001", true);
  const store = (await storeForEmail(owner))!;

  part("Control: a succeeded $10 refund is money given back");
  refund = { status: "succeeded", amount: 1000 };
  const ok = (await readSales(store, NOW))!;
  is("control: $10 out, complete", [out7(ok), ok.cashflowComplete], [1000, true]);
  is("control: the channel kept $10 less", keptRefunds(ok), 1000);

  part("A pending refund is not confirmed cash out");
  refund = { status: "pending", amount: 1000 };
  const pending = (await readSales(store, NOW))!;
  is("pending refund contributes no confirmed cash outflow", out7(pending) ?? 0, 0);
  is("pending refund takes nothing off what the channel kept", keptRefunds(pending) ?? 0, 0);
  is("the reading is still complete", pending.cashflowComplete, true);

  part("The careful readers still see the pending refund");
  const careful = await readStoreRefunds(store, 0, 1);
  is("readStoreRefunds keeps the pending refund", careful.rows.map((r) => r.cents), [1000]);
  done();
}
main().catch((error) => { console.error(error); process.exit(1); });
