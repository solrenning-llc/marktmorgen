/**
 * #4371 (Codex X8, transcribed by Claude 2): a renewal's money is put on the
 * UTC day the payment was confirmed (the invoice's status_transitions.paid_at),
 * not the day the invoice was made. A renewal invoiced before the window and
 * paid inside it after a retry is read and counted inside it. A paid invoice
 * that does not say when it was paid is unknown: the reading is partial,
 * never a guess from its creation day. Synthetic Stripe answers only.
 */
import { readSales } from "@/lib/stats";
import { claimHandle, ensureStatsId, setStripeAccount, storeForEmail } from "@/lib/store";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";

process.env.STRIPE_SECRET_KEY = "sk_test_cashflow_stand_in";
const NOW = Date.parse("2026-11-12T12:00:00Z");
const DAY = 86_400;
const sec = (iso: string) => Date.parse(iso) / 1000;
let invoice: Record<string, unknown> | null = null;
const asked: string[] = [];
globalThis.fetch = (async (input: string | URL | Request) => {
  const url = new URL(String(input));
  const list = (data: unknown[], hasMore = false) => new Response(JSON.stringify({ data, has_more: hasMore }), { status: 200 });
  if (url.pathname.endsWith("/invoices")) {
    asked.push(url.search);
    const gte = Number(url.searchParams.get("created[gte]"));
    return list(invoice && Number(invoice.created) >= gte ? [invoice] : []);
  }
  return list([]);
}) as typeof fetch;

const renewal = (created: string, paid: string | null): Record<string, unknown> => ({
  id: "in_TestRenewal01", object: "invoice", status: "paid", billing_reason: "subscription_cycle", amount_paid: 7500, currency: "usd",
  created: sec(created), ...(paid === null ? {} : { status_transitions: { paid_at: sec(paid) } }),
  parent: { subscription_details: { metadata: { store: "cashflow", channel: "newsletter" } } },
  subscription_details: { metadata: { store: "cashflow", channel: "newsletter" } },
});

async function main() {
  redis.clear();
  const owner = "cashflow-owner@example.com";
  await claimHandle(owner, "cashflow", "Cashflow", "");
  await ensureStatsId(owner);
  await setStripeAccount(owner, "acct_TestCashflow001", true);
  const store = (await storeForEmail(owner))!;

  part("A renewal invoiced on Nov 3 and paid on Nov 11 after a retry");
  invoice = renewal("2026-11-03T09:00:00Z", "2026-11-11T09:00:00Z");
  const read = (await readSales(store, NOW))!;
  is("it is in the last 7 days", [read.renewals?.d7.payments, read.renewals?.d7.cents], [1, 7500]);
  is("on the day it was paid, under its channel", read.renewals?.bySourceDay?.newsletter, { "2026-11-11": 7500 });
  is("and the reading is complete", read.renewals?.partial, false);

  part("A renewal invoiced before the 90 days and paid inside them");
  invoice = renewal(new Date(NOW - 100 * DAY * 1000).toISOString(), new Date(NOW - 80 * DAY * 1000).toISOString());
  const late = (await readSales(store, NOW))!;
  is("it is read and counted in the 90 days", [late.renewals?.d90.payments, late.renewals?.d90.cents], [1, 7500]);
  is("the invoices were asked from before the window", asked.some((q) => Number(new URLSearchParams(q).get("created[gte]")) <= Math.floor(NOW / 1000) - 100 * DAY), true);

  part("A renewal paid before the 90 days is not in them");
  invoice = renewal(new Date(NOW - 110 * DAY * 1000).toISOString(), new Date(NOW - 95 * DAY * 1000).toISOString());
  const before = (await readSales(store, NOW))!;
  is("not counted", before.renewals?.d90.payments, 0);

  part("A paid renewal that does not say when it was paid");
  invoice = renewal("2026-11-10T09:00:00Z", null);
  const unknown = (await readSales(store, NOW))!;
  is("the reading is partial, not put on its creation day", [unknown.renewals?.partial, unknown.renewals?.d7.payments], [true, 0]);
  done();
}
main().catch((error) => { console.error(error); process.exit(1); });
