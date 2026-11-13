/**
 * #4369, #4370, #4374 (Codex X8, transcribed by Claude 2): a refund or a
 * dispute row is counted only as what Stripe says it is, and a row that does
 * not say is never certified (rule 24).
 *
 *   - a pending refund is not money given back yet (#4369): only a
 *     succeeded one is confirmed cash out; a failed, canceled or
 *     requires_action one is none;
 *   - a refund with a status this code does not know, or a succeeded one
 *     whose amount is not a whole positive number, leaves the cash-flow
 *     reading not complete (#4370);
 *   - a dispute with no status this code knows, or one that takes the money
 *     with no readable amount, leaves the disputes reading not complete and
 *     the kept money unknown (#4374); a won one still takes nothing.
 * Synthetic Stripe answers only.
 */
import { readSales } from "@/lib/stats";
import { claimHandle, ensureStatsId, setStripeAccount, storeForEmail } from "@/lib/store";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";

process.env.STRIPE_SECRET_KEY = "sk_test_cashflow_stand_in";
const NOW = Date.parse("2026-10-13T12:00:00Z");
let refund: Record<string, unknown> | null = null;
let dispute: Record<string, unknown> | null = null;
globalThis.fetch = (async (input: string | URL | Request) => {
  const url = new URL(String(input));
  const list = (data: unknown[], hasMore = false) => new Response(JSON.stringify({ data, has_more: hasMore }), { status: 200 });
  if (url.pathname.endsWith("/checkout/sessions")) return list([{
    id: "cs_test_cashflow0001", status: "complete", payment_status: "paid", amount_total: 5000,
    currency: "usd", created: NOW / 1000, payment_intent: "pi_cashflow0001", customer_details: { email: "buyer@example.com" },
    metadata: { store: "cashflow", product: "p1", channel: "instagram" },
  }]);
  if (url.pathname.endsWith("/refunds")) return list(refund ? [{ id: "re_1", currency: "usd", created: NOW / 1000, payment_intent: "pi_cashflow0001", ...refund }] : []);
  if (url.pathname.endsWith("/disputes")) return list(dispute ? [{ id: "dp_1", currency: "usd", created: NOW / 1000, payment_intent: "pi_cashflow0001", ...dispute }] : []);
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
  const kept = (r: Read) => (r as unknown as { keptIn?: { d7?: { lines?: { currency: string; keptCents: number | null }[] } } })?.keptIn?.d7?.lines?.find((row) => row.currency === "usd")?.keptCents;

  part("Refunds (#4369, #4370)");
  refund = { status: "succeeded", amount: 1000 };
  const ok = (await readSales(store, NOW))!;
  is("control: a succeeded $10 refund is $10 out, complete", [out7(ok), ok.cashflowComplete], [1000, true]);
  for (const status of ["pending", "requires_action"]) {
    refund = { status, amount: 1000 };
    const waiting = (await readSales(store, NOW))!;
    is(`a ${status} refund is no confirmed cash out, and the reading stays complete`, [out7(waiting), waiting.cashflowComplete], [0, true]);
  }
  for (const status of ["failed", "canceled"]) {
    refund = { status, amount: 1000 };
    const none = (await readSales(store, NOW))!;
    is(`control: a ${status} refund is no outflow, complete`, [out7(none), none.cashflowComplete], [0, true]);
  }
  for (const [what, row] of [
    ["succeeded without an amount", { status: "succeeded" }],
    ["succeeded with an amount as text", { status: "succeeded", amount: "1000" }],
    ["succeeded with a zero amount", { status: "succeeded", amount: 0 }],
    ["succeeded with a fractional amount", { status: "succeeded", amount: 10.5 }],
    ["a status this code does not know", { status: "requires_magic", amount: 1000 }],
    ["no status at all", { amount: 1000 }],
  ] as const) {
    refund = { ...row };
    is(`a refund ${what}: the cash-flow reading is not complete`, (await readSales(store, NOW))!.cashflowComplete, false);
  }
  refund = null;

  part("Disputes (#4374)");
  dispute = { status: "lost", amount: 2500 };
  const lost = (await readSales(store, NOW))!;
  is("control: a lost $25 dispute -> complete, $25 kept", [lost.disputesComplete, kept(lost)], [true, 2500]);
  for (const [what, row] of [
    ["with no status", { amount: 2500 }],
    ["with a status this code does not know", { status: "argued_on_mars", amount: 2500 }],
    ["lost with no amount", { status: "lost" }],
    ["lost with an amount as text", { status: "lost", amount: "2500" }],
    ["needs_response with a zero amount", { status: "needs_response", amount: 0 }],
  ] as const) {
    dispute = { ...row };
    const read = (await readSales(store, NOW))!;
    is(`a dispute ${what}: not complete, kept unknown`, [read.disputesComplete, kept(read)], [false, null]);
  }
  for (const status of ["won", "warning_closed", "warning_needs_response", "warning_under_review", "charge_refunded"]) {
    dispute = { status, amount: 2500 };
    const read = (await readSales(store, NOW))!;
    is(`control: a ${status} dispute deducts nothing, complete`, [read.disputesComplete, kept(read)], [true, 5000]);
  }
  done();
}
main().catch((error) => { console.error(error); process.exit(1); });
