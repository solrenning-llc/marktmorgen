// X8-2321 (#4374): a dispute row with no recognized status, or one that takes
// the money with no readable amount, leaves the dispute reading partial and
// the kept money unknown, instead of being dropped from a "complete" reading.
import { disputeTakes } from "@/lib/retained-revenue";
import { readSales, type SalesStats } from "@/lib/stats";
import { claimHandle, ensureStatsId, setStripeAccount, storeForEmail } from "@/lib/store";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";

process.env.STRIPE_SECRET_KEY = "sk_test_cashflow_stand_in";
const NOW = Date.parse("2026-10-13T12:00:00Z");
let dispute: Record<string, unknown> | null = null;
globalThis.fetch = (async (input: string | URL | Request) => {
  const url = new URL(String(input));
  const list = (data: unknown[], hasMore = false) => new Response(JSON.stringify({ data, has_more: hasMore }), { status: 200 });
  if (url.pathname.endsWith("/checkout/sessions")) return list([{
    id: "cs_test_cashflow0001", status: "complete", payment_status: "paid", amount_total: 5000,
    currency: "usd", created: NOW / 1000, payment_intent: "pi_cashflow0001", customer_details: { email: "buyer@example.com" },
    metadata: { store: "cashflow", product: "p1", channel: "instagram" },
  }]);
  if (url.pathname.endsWith("/disputes")) return list(dispute ? [{ id: "dp_1", currency: "usd", created: NOW / 1000, payment_intent: "pi_cashflow0001", ...dispute }] : []);
  return list([]);
}) as typeof fetch;

async function main() {
  part("disputeTakes: a status it does not know is unknown, never 'takes nothing'");
  for (const status of ["warning_needs_response", "warning_under_review", "warning_closed", "won", "charge_refunded"]) {
    is(`${status} takes nothing`, disputeTakes({ status }), false);
  }
  for (const status of ["needs_response", "under_review", "lost"]) is(`${status} takes the money`, disputeTakes({ status }), true);
  is("no status: unknown", disputeTakes({}), null);
  is("a status not documented: unknown", disputeTakes({ status: "something_new" }), null);
  is("a status that is not a string: unknown", disputeTakes({ status: 3 }), null);

  part("Unreadable dispute rows leave kept money unknown");
  redis.clear();
  const owner = "cashflow-owner@example.com";
  await claimHandle(owner, "cashflow", "Cashflow", "");
  await ensureStatsId(owner);
  await setStripeAccount(owner, "acct_TestCashflow001", true);
  const store = (await storeForEmail(owner))!;
  const kept = (r: SalesStats) => r.keptIn?.d7.lines.find((row) => row.currency === "usd")?.keptCents;
  dispute = { status: "lost", amount: 2500 };
  const lost = (await readSales(store, NOW))!;
  is("control: a lost $25 dispute -> complete, $25 kept", [lost.disputesComplete, kept(lost)], [true, 2500]);
  dispute = { amount: 2500 };
  const noStatus = (await readSales(store, NOW))!;
  is("dispute without status: not complete, kept unknown", [noStatus.disputesComplete, kept(noStatus)], [false, null]);
  dispute = { status: "lost" };
  const noAmount = (await readSales(store, NOW))!;
  is("lost dispute without amount: not complete, kept unknown", [noAmount.disputesComplete, kept(noAmount)], [false, null]);
  dispute = { status: "lost", amount: 0 };
  const zeroAmount = (await readSales(store, NOW))!;
  is("lost dispute with a zero amount: not complete, kept unknown", [zeroAmount.disputesComplete, kept(zeroAmount)], [false, null]);
  dispute = { status: "won", amount: 2500 };
  const won = (await readSales(store, NOW))!;
  is("control: a won dispute deducts nothing", [won.disputesComplete, kept(won)], [true, 5000]);
  dispute = { status: "warning_closed" };
  const inquiry = (await readSales(store, NOW))!;
  is("control: a closed inquiry with no amount deducts nothing", [inquiry.disputesComplete, kept(inquiry)], [true, 5000]);
  done();
}
main().catch((error) => { console.error(error); process.exit(1); });
