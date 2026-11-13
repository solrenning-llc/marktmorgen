import { readSales } from "@/lib/stats";
import { claimHandle, ensureStatsId, setStripeAccount, storeForEmail } from "@/lib/store";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";

// Issue #4388: a paid renewal invoice of the store whose amount_paid is missing,
// negative, fractional or not a safe integer cannot be read, so the renewal
// reading is partial and the payments are not certified complete. A known zero
// is no cash entry and keeps the reading complete.
process.env.STRIPE_SECRET_KEY = "sk_test_renewal_amount_stand_in";
const NOW = Date.parse("2026-10-13T12:00:00Z");
let invoiceAmount: unknown = 4800;
globalThis.fetch = (async (input: string | URL | Request) => {
  const url = new URL(String(input));
  const list = (data: unknown[]) => new Response(JSON.stringify({ data, has_more: false }), { status: 200 });
  if (url.pathname.endsWith("/invoices")) {
    const invoice: Record<string, unknown> = {
      id: "in_test_renewal0001", status: "paid", billing_reason: "subscription_cycle", currency: "jpy",
      created: NOW / 1000 - 86400, status_transitions: { paid_at: NOW / 1000 - 86400 }, subscription_details: { metadata: { store: "renewamt", channel: "direct" } },
    };
    if (invoiceAmount !== undefined) invoice.amount_paid = invoiceAmount;
    return list([invoice]);
  }
  return list([]);
}) as typeof fetch;

async function main() {
  redis.clear();
  const owner = "renewal-amount-owner@example.com";
  await claimHandle(owner, "renewamt", "Renewal Amount", "");
  await ensureStatsId(owner);
  await setStripeAccount(owner, "acct_TestRenewAmount1", true);
  const store = (await storeForEmail(owner))!;
  part("A renewal amount must be whole minor units to certify the renewal reading");
  invoiceAmount = 4800;
  const control = (await readSales(store, NOW))!;
  is("a JPY 4800 renewal is a complete reading", [control.renewals?.partial, control.paymentsComplete], [false, true]);
  invoiceAmount = 0;
  const zero = (await readSales(store, NOW))!;
  is("a known zero renewal is no cash entry and stays complete", [zero.renewals?.partial, zero.paymentsComplete], [false, true]);
  for (const v of [undefined, null, 4800.5, -100, "4800", Number.MAX_SAFE_INTEGER + 2]) {
    invoiceAmount = v;
    const r = (await readSales(store, NOW))!;
    is(`amount_paid ${JSON.stringify(v) ?? "undefined"}: renewals partial and payments incomplete`, [r.renewals?.partial, r.paymentsComplete], [true, false]);
  }
  done();
}
main().catch((error) => { console.error(error); process.exit(1); });
