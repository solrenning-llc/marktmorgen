import { readPaidSales, salesCsv } from "@/lib/stats";
import { claimHandle, ensureStatsId, setStripeAccount, storeForEmail } from "@/lib/store";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";

// Issue #4386: a paid checkout or a succeeded post-purchase offer whose amount
// is not whole minor units cannot be read, so it is never recorded as a sale of
// zero and the sales reading is partial, with the reason named. Valid USD and
// JPY amounts keep Stripe's minor units as they are.
process.env.STRIPE_SECRET_KEY = "sk_test_paid_amount_stand_in";
const NOW = Date.parse("2026-10-13T12:00:00Z");
let checkoutAmount: unknown = 5000;
let checkoutCurrency = "usd";
let upsellAmount: unknown = 1200;
globalThis.fetch = (async (input: string | URL | Request) => {
  const url = new URL(String(input));
  const list = (data: unknown[]) => new Response(JSON.stringify({ data, has_more: false }), { status: 200 });
  if (url.pathname.endsWith("/checkout/sessions")) {
    const row: Record<string, unknown> = {
      id: "cs_test_paidamount01", status: "complete", payment_status: "paid", currency: checkoutCurrency,
      created: NOW / 1000, payment_intent: "pi_paidamount01", metadata: { store: "paidamt", product: "p1" },
    };
    if (checkoutAmount !== undefined) row.amount_total = checkoutAmount;
    return list([row]);
  }
  if (url.pathname.endsWith("/payment_intents")) {
    const pi: Record<string, unknown> = {
      id: "pi_paidamount_upsell1", status: "succeeded", currency: "usd", created: NOW / 1000,
      metadata: { kind: "upsell", store: "paidamt", product: "p2" },
    };
    if (upsellAmount !== undefined) pi.amount = upsellAmount;
    return list([pi]);
  }
  return list([]);
}) as typeof fetch;

async function main() {
  redis.clear();
  const owner = "paid-amount-owner@example.com";
  await claimHandle(owner, "paidamt", "Paid Amount", "");
  await ensureStatsId(owner);
  await setStripeAccount(owner, "acct_TestPaidAmount01", true);
  const store = (await storeForEmail(owner))!;
  const since = NOW / 1000 - 86400;
  part("A paid amount must be whole minor units to be a sale");
  const control = await readPaidSales(store, since, 1);
  is("USD 5000 checkout and 1200 upsell: complete, as Stripe gave them", [control.partial, control.sales.map((s) => s.cents).sort()], [false, [1200, 5000]]);
  checkoutCurrency = "jpy";
  checkoutAmount = 4800;
  const yen = await readPaidSales(store, since, 1);
  is("JPY 4800 checkout keeps its minor units", [yen.partial, yen.sales.find((s) => !s.upsell)?.cents], [false, 4800]);
  checkoutCurrency = "usd";
  checkoutAmount = 0;
  const free = await readPaidSales(store, since, 1);
  is("a known zero checkout is a sale of zero and stays complete", [free.partial, free.sales.find((s) => !s.upsell)?.cents], [false, 0]);
  for (const v of [null, undefined, 5000.5, -1, "5000", Number.MAX_SAFE_INTEGER + 2]) {
    checkoutAmount = v;
    const bad = await readPaidSales(store, since, 1);
    is(`checkout amount_total ${JSON.stringify(v) ?? "undefined"}: partial, no invented sale`,
      [bad.partial, bad.gaps.includes("amount"), bad.sales.some((s) => !s.upsell)], [true, true, false]);
  }
  checkoutAmount = 5000;
  for (const v of [undefined, null, 0, 12.5, -5]) {
    upsellAmount = v;
    const bad = await readPaidSales(store, since, 1);
    is(`succeeded upsell amount ${JSON.stringify(v) ?? "undefined"}: partial, no invented sale`,
      [bad.partial, bad.gaps.includes("amount"), bad.sales.some((s) => s.upsell)], [true, true, false]);
  }
  part("The export never writes an invented amount");
  checkoutAmount = null;
  upsellAmount = 1200;
  const csv = await salesCsv(store, since);
  is("the CSV leaves the unreadable checkout out and says it is partial", [csv.partial, csv.rows, csv.csv.includes("cs_test_paidamount01")], [true, 1, false]);
  done();
}
main().catch((error) => { console.error(error); process.exit(1); });
