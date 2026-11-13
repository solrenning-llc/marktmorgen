// A renewal's money comes in on the day Stripe confirmed the payment
// (status_transitions.paid_at), not on the day the invoice was made: an
// installment invoiced on Nov 3 and paid after a retry on Nov 11 is in the
// last 7 days on Nov 12, on Nov 11 in the channel's days and in the money
// kept. The read also takes in an invoice made before the window but paid
// inside it (issue #4371, Codex X8-2311).
import { readSales, renewalEntries, renewalsFrom } from "@/lib/stats";
import { claimHandle, ensureStatsId, setStripeAccount, storeForEmail } from "@/lib/store";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";

const NOW = Date.UTC(2026, 10, 12, 12);
const sec = (ms: number) => Math.floor(ms / 1000);
const daysAgo = (n: number) => sec(NOW - n * 86_400_000);
const invoice = (id: string, created: number, paidAt: number | undefined) => ({
  id, object: "invoice", status: "paid", billing_reason: "subscription_cycle", amount_paid: 7500, currency: "usd", created,
  ...(paidAt === undefined ? {} : { status_transitions: { paid_at: paidAt } }),
  subscription_details: { metadata: { store: "harbor", product: "club01", channel: "newsletter" } },
});

let invoices: Record<string, unknown>[] = [];
globalThis.fetch = (async (input: string | URL | Request) => {
  const url = new URL(String(input));
  const path = url.pathname.replace(/^\/v1/, "");
  const list = (data: unknown[]) => new Response(JSON.stringify({ object: "list", data, has_more: false }));
  // Stripe lists invoices by when they were made, never by when they were paid.
  if (path === "/invoices" && url.searchParams.get("status") === "paid") {
    const from = Number(url.searchParams.get("created[gte]") ?? 0);
    return list(invoices.filter((i) => (i.created as number) >= from));
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

  part("Invoiced on Nov 3, paid after a retry on Nov 11, read on Nov 12");
  const late = invoice("in_late_1", sec(Date.UTC(2026, 10, 3, 9)), sec(Date.UTC(2026, 10, 11, 9)));
  const report = renewalsFrom(store, [late], NOW, "usd");
  is("counted in the last 7 days (paid on Nov 11)", report.d7.cents, 7500);
  is("on its payment day in the channel's days", report.bySourceDay.newsletter, { "2026-11-11": 7500 });
  is("money-kept entry on its payment day", renewalEntries(store, [late])[0]?.day, "2026-11-11");

  part("Control: an invoice with no payment time stays on the day it was made");
  const plain = invoice("in_plain_1", sec(Date.UTC(2026, 10, 10, 9)), undefined);
  is("day it was made", renewalEntries(store, [plain])[0]?.day, "2026-11-10");

  part("Made before the 90 days, paid inside them: read and counted");
  invoices = [invoice("in_old_paid_late", daysAgo(95), daysAgo(2))];
  const read = (await readSales(store, NOW))!;
  is("in the last 7 days of the read", read.renewals?.d7.cents, 7500);

  part("Made and paid before the 90 days: not in any window");
  invoices = [invoice("in_old_paid_old", daysAgo(120), daysAgo(95))];
  const old = (await readSales(store, NOW))!;
  is("not in the 90 days", old.renewals?.d90.cents, 0);
  done();
}
main().catch((error) => { console.error(error); process.exit(1); });
