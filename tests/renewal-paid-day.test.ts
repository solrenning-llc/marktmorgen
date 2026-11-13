/**
 * A renewal is money in on the day it was paid, not on the day its invoice was
 * made (#4371; Codex X8). A renewal invoiced before the read's window and paid
 * inside it, after a retry, is in the window; one paid before the window is not.
 */
import { readSales, renewalEntries, renewalsFrom } from "@/lib/stats";
import { claimHandle, ensureStatsId, setStripeAccount, storeForEmail } from "@/lib/store";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";

const NOW = Date.UTC(2026, 10, 12, 12);
const DAY = 86400;
const invoice = (id: string, created: number, paidAt: number | undefined) => ({
  id, object: "invoice", status: "paid", billing_reason: "subscription_cycle", amount_paid: 7500, currency: "usd",
  created, ...(paidAt === undefined ? {} : { status_transitions: { paid_at: paidAt } }),
  subscription_details: { metadata: { store: "harbor", product: "club01", channel: "newsletter" } },
});
let invoices: Record<string, unknown>[] = [];
let createdFrom = -1;
globalThis.fetch = (async (input: string | URL | Request) => {
  const url = new URL(String(input));
  const list = (data: unknown[]) => new Response(JSON.stringify({ object: "list", data, has_more: false }), { status: 200 });
  if (url.pathname.endsWith("/invoices")) {
    createdFrom = Number(url.searchParams.get("created[gte]"));
    return list(invoices.filter((i) => (i.created as number) >= createdFrom));
  }
  return list([]);
}) as typeof fetch;

async function main(): Promise<void> {
  redis.clear();
  process.env.STRIPE_SECRET_KEY = "sk_test_renewals_only_a_stand_in";
  await claimHandle("owner@example.com", "harbor", "Harbor Kitchen", "");
  await ensureStatsId("owner@example.com");
  await setStripeAccount("owner@example.com", "acct_1TestHarbor0001", true);
  const store = (await storeForEmail("owner@example.com"))!;

  part("A renewal invoiced on Nov 3, paid after a retry on Nov 11, read on Nov 12 (#4371)");
  const late = invoice("in_late_1", Date.UTC(2026, 10, 3, 9) / 1000, Date.UTC(2026, 10, 11, 9) / 1000);
  const report = renewalsFrom(store, [late], NOW, "usd");
  is("counted in the last 7 days (paid on Nov 11)", report.d7.cents, 7500);
  is("on its payment day in the channel's days", report.bySourceDay.newsletter, { "2026-11-11": 7500 });
  is("retained-revenue entry on its payment day", renewalEntries(store, [late])[0]?.day, "2026-11-11");

  part("An invoice that does not say when it was paid keeps its creation day");
  const plain = invoice("in_plain_1", Date.UTC(2026, 10, 10, 9) / 1000, undefined);
  is("the day it was made", renewalEntries(store, [plain])[0]?.day, "2026-11-10");

  part("The read covers an invoice made before its window and paid inside it");
  const since = Math.floor(NOW / 1000) - 90 * DAY;
  const madeBefore = invoice("in_before_1", since - 20 * DAY, since + 2 * DAY);
  const paidBefore = invoice("in_paid_before_1", since - 30 * DAY, since - 3 * DAY);
  invoices = [madeBefore, paidBefore];
  const sales = (await readSales(store, NOW))!;
  is("the invoices are asked for from before the window", createdFrom < since - 20 * DAY, true);
  is("the one paid inside the window is counted once; the one paid before it is not", [sales.renewals?.d90.payments, sales.renewals?.d90.cents], [1, 7500]);
  done();
}
main().catch((error) => { console.error(error); process.exit(1); });
