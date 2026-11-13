/**
 * #4388: a paid renewal of the store whose amount_paid Stripe answers missing, null, fractional, negative or past a
 * safe integer is never counted as a renewal of $0, nor summed as it came. The renewals reading leaves it out and is
 * partial, so the payments are never said to be complete (lib/stats.ts renewalsFrom, renewalEntries, readRenewals).
 * The same for the renewal payments read for the buyers' ledger (readRenewalPayments). An explicit 0 is no payment
 * and no gap. Stripe is a stand-in for fetch; synthetic store, in-memory Redis.
 */
import { readRenewalPayments, readSales } from "@/lib/stats";
import { claimHandle, ensureStatsId, setStripeAccount, storeForEmail } from "@/lib/store";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";

process.env.STRIPE_SECRET_KEY = "sk_test_renewal_amount_stand_in";
const NOW = Date.parse("2026-10-13T12:00:00Z");
let amountPaid: unknown = 4800;
let currency = "usd";
globalThis.fetch = (async (input: string | URL | Request) => {
  const url = new URL(String(input));
  const list = (data: unknown[]) => new Response(JSON.stringify({ object: "list", data, has_more: false }), { status: 200 });
  if (url.pathname.endsWith("/invoices")) return list(url.searchParams.get("status") === "paid" ? [{
    id: "in_Renewal0001", object: "invoice", status: "paid", billing_reason: "subscription_cycle", amount_paid: amountPaid,
    currency, created: NOW / 1000 - 3600, customer_email: "member@example.com", payment_intent: "pi_renewal0001",
    subscription_details: { metadata: { store: "renewals", product: "club", channel: "newsletter" } },
  }] : []);
  return list([]);
}) as typeof fetch;

async function main(): Promise<void> {
  redis.clear();
  const owner = "renewals-owner@example.com";
  await claimHandle(owner, "renewals", "Renewals", "");
  await ensureStatsId(owner);
  await setStripeAccount(owner, "acct_TestRenewals001", true);
  const store = (await storeForEmail(owner))!;
  const read = async () => {
    const r = (await readSales(store, NOW))!;
    return { partial: r.renewals?.partial, complete: r.paymentsComplete, d90: r.renewals?.d90 };
  };
  const ledger = async () => {
    const r = await readRenewalPayments(store, Math.floor(NOW / 1000) - 86_400, 1);
    return { partial: r.partial, cents: r.rows.map((row) => row.cents) };
  };

  part("A whole amount is counted; an explicit 0 is no payment and no gap");
  is("$48 renewal: counted, complete", await read(), { partial: false, complete: true, d90: { payments: 1, cents: 4800 } });
  is("and in the ledger", await ledger(), { partial: false, cents: [4800] });
  currency = "jpy";
  is("JPY 4800 as it is, in its own currency (not the store's line)", (await read()).partial, false);
  currency = "usd";
  amountPaid = 0;
  is("an explicit 0: no payment, no gap", await read(), { partial: false, complete: true, d90: { payments: 0, cents: 0 } });

  part("An amount that does not read is never $0, nor summed as it came");
  for (const bad of [undefined, null, 4800.5, -100, Number.MAX_SAFE_INTEGER + 1, "4800"]) {
    amountPaid = bad;
    is(`amount_paid ${JSON.stringify(bad) ?? "missing"}: left out, partial, payments not complete`, await read(), { partial: true, complete: false, d90: { payments: 0, cents: 0 } });
    is(`amount_paid ${JSON.stringify(bad) ?? "missing"}: left out of the ledger, which is partial`, await ledger(), { partial: true, cents: [] });
  }

  done();
}

main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
