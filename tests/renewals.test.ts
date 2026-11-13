/**
 * Renewals in the studio's numbers (lib/stats.ts, renewalsFrom and readSales,
 * added 11 October 2026). What is checked:
 *
 *   - a payment after the first is a paid invoice Stripe made because a
 *     period came round, on a subscription this store opened, in its
 *     currency: a first payment (a checkout, already a sale), an unpaid or
 *     free invoice, another store's or another currency's is not one;
 *   - the subscription's store is read where either of Stripe's API versions
 *     keeps it;
 *   - each is counted in the windows it falls in, and read beside the sales.
 */
import { readSales, renewalsFrom } from "@/lib/stats";
import { claimHandle, ensureStatsId, setStripeAccount, storeForEmail } from "@/lib/store";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";

const NOW = Date.UTC(2026, 9, 11, 12);
const at = (daysAgo: number) => Math.floor((NOW - daysAgo * 86_400_000) / 1000);
let invoiceNumber = 0;
const invoice = (over: Record<string, unknown>) => {
  const made: Record<string, unknown> = {
    id: `in_renewal_${++invoiceNumber}`,
    object: "invoice",
    status: "paid",
    billing_reason: "subscription_cycle",
    amount_paid: 2000,
    currency: "usd",
    created: at(1),
    subscription_details: { metadata: { store: "harbor", product: "club01" } },
    ...over,
  };
  // A paid invoice says when it was paid (status_transitions.paid_at); here, when it was made, unless a case says otherwise.
  return "status_transitions" in over ? made : { ...made, status_transitions: { paid_at: made.created } };
};

let invoices: Record<string, unknown>[] = [];
globalThis.fetch = (async (input: string | URL | Request) => {
  const url = new URL(String(input));
  const path = url.pathname.replace(/^\/v1/, "");
  const list = (data: unknown[]) => new Response(JSON.stringify({ object: "list", data, has_more: false }));
  if (path === "/invoices") return list(url.searchParams.get("status") === "paid" ? invoices : []);
  return list([]);
}) as typeof fetch;

async function main(): Promise<void> {
  redis.clear();
  process.env.STRIPE_SECRET_KEY = "sk_test_renewals_only_a_stand_in";
  await claimHandle("owner@example.com", "harbor", "Harbor Kitchen", "");
  await ensureStatsId("owner@example.com");
  await setStripeAccount("owner@example.com", "acct_1TestHarbor0001", true);
  const store = (await storeForEmail("owner@example.com"))!;

  part("What counts as a payment after the first");
  const all = [
    invoice({}),
    invoice({ billing_reason: "subscription_create" }),
    invoice({ status: "open" }),
    invoice({ amount_paid: 0 }),
    invoice({ subscription_details: { metadata: { store: "elsewhere" } } }),
    invoice({ currency: "eur" }),
    invoice({ subscription_details: null, parent: { subscription_details: { metadata: { store: "harbor", kind: "plan" } } }, amount_paid: 11_000, created: at(20) }),
    invoice({ created: at(60), amount_paid: 900 }),
  ];
  const counted = renewalsFrom(store, all, NOW, "usd");
  is("a renewal of this store, a later plan payment read from the newer place, and an older renewal", counted.d90, { payments: 3, cents: 2000 + 11_000 + 900 });
  is("each in the windows it falls in", [counted.d7, counted.d30], [{ payments: 1, cents: 2000 }, { payments: 2, cents: 13_000 }]);

  part("Read beside the sales");
  invoices = all;
  const sales = await readSales(store, NOW);
  is("the studio's reading carries them", sales?.renewals ? [sales.renewals.d30, sales.renewals.partial] : null, [{ payments: 2, cents: 13_000 }, false]);

  done();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
