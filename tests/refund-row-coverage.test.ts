// Issue #4370 (Codex X8-2310): a refund row with a status outside Stripe's
// documented set, or a row that gives money back without a readable amount,
// leaves the cash-flow reading partial instead of certifying it complete.
// States: https://docs.stripe.com/api/refunds/object (pending,
// requires_action, succeeded, failed, canceled).
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
  const out7 = (r: Awaited<ReturnType<typeof readSales>>) =>
    r?.refundsIn?.d7?.reduce((s: number, row: { cents: number }) => s + row.cents, 0);
  const complete = async () => (await readSales(store, NOW))!.cashflowComplete;

  part("Control: a succeeded $10 refund");
  refund = { status: "succeeded", amount: 1000 };
  const ok = (await readSales(store, NOW))!;
  is("control: $10 out, complete", [out7(ok), ok.cashflowComplete], [1000, true]);

  part("Unreadable refund rows cannot certify the cash flow complete");
  refund = { status: "succeeded" };
  is("succeeded without amount: cashflow not complete", await complete(), false);
  refund = { status: "succeeded", amount: "1000" };
  is("succeeded with a text amount: cashflow not complete", await complete(), false);
  refund = { status: "succeeded", amount: 10.5 };
  is("succeeded with a fractional amount: cashflow not complete", await complete(), false);
  refund = { status: "succeeded", amount: 0 };
  is("succeeded with a zero amount: cashflow not complete", await complete(), false);
  refund = { status: "succeeded", amount: -1000 };
  is("succeeded with a negative amount: cashflow not complete", await complete(), false);
  refund = { status: "succeeded", amount: 2 ** 60 };
  is("succeeded with an amount past safe precision: cashflow not complete", await complete(), false);
  // A pending refund is no money given back yet (#4369), with or without an amount, so it leaves the reading complete.
  refund = { status: "pending" };
  is("pending without amount: no outflow yet, cashflow complete", await complete(), true);
  refund = { status: "requires_magic", amount: 1000 };
  is("unknown status: cashflow not complete", await complete(), false);
  refund = { amount: 1000 };
  is("no status: cashflow not complete", await complete(), false);

  part("Known statuses that give nothing back stay complete");
  for (const status of ["failed", "canceled", "requires_action"]) {
    refund = { status, amount: 1000 };
    const known = (await readSales(store, NOW))!;
    is(`control: a known ${status} refund is no outflow and complete`, [out7(known) ?? 0, known.cashflowComplete], [0, true]);
  }
  done();
}
main().catch((error) => { console.error(error); process.exit(1); });
