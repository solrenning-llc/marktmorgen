import { done, is, part } from "./check";
import { store as redis } from "./redis-stub";
import { paidPeriod } from "./billing-period-fixture";

// The studio's sales list and the people page's latest buyers format each sale with its currency, read from the
// creator's Stripe account (lib/store-checkout.ts, listSales). A paid checkout whose currency is missing, empty, not
// text or not a three-letter lowercase code was shown as US dollars: a sale in another currency appeared as money the
// creator never saw (#5010 row 95, Codex X8-20261119-1617, MEDIUM, money). Now such a code is unknown and the list
// says it could not be read, as it already does for an offer's payment with no readable currency (rule 24). Not
// replaced by the store's currency either: a sale made before a change of currency was not paid in today's.
// Synthetic Stripe replies only; nothing leaves this process.

const BASE = "http://127.0.0.1:4998";
const MISSING = Symbol("missing");

async function main(): Promise<void> {
  process.env.STRIPE_SECRET_KEY = "sk_test_list_sales_currency_only_a_stand_in";
  process.env.STRIPE_CONNECT_API_BASE = BASE;
  let rows: Record<string, unknown>[] = [];
  let reads = 0;
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input));
    if (url.origin !== BASE || (init?.method ?? "GET") !== "GET") throw new Error("Only synthetic order reads are allowed");
    reads += 1;
    const body = url.pathname === "/v1/checkout/sessions" ? { object: "list", data: rows, has_more: false }
      : url.pathname === "/v1/payment_intents" ? { object: "list", data: [], has_more: false }
      : null;
    if (body === null) throw new Error("Unexpected synthetic endpoint");
    const response = new Response("{}", { status: 200 });
    Object.defineProperty(response, "json", { value: async () => body });
    return response;
  }) as typeof fetch;

  redis.clear();
  const { claimHandle, setStripeAccount, setSubscription, storeForEmail } = await import("@/lib/store");
  const { listSales } = await import("@/lib/store-checkout");
  const email = "list-sales-currency@example.test";
  await claimHandle(email, "listsalescurrency", "Sales currency proof", "");
  await setStripeAccount(email, "acct_fixture048", true);
  await setSubscription(email, { customerId: "cus_ListSalesCurr01", subscriptionId: "sub_ListSalesCurr01", active: true, period: paidPeriod() });
  const store = (await storeForEmail(email))!;
  const now = Math.floor(Date.now() / 1000);
  const row = (id: string, currency: unknown, handle = store.handle): Record<string, unknown> => ({
    id, status: "complete", payment_status: "paid", created: now - 60, amount_total: 4900,
    ...(currency === MISSING ? {} : { currency }),
    metadata: { store: handle, title: `Synthetic ${id}` },
    customer_details: { email: `${id}@example.test` },
  });

  part("A sale whose currency Stripe did not give as a code is unknown, never US dollars");
  for (const [what, currency] of [["missing", MISSING], ["null", null], ["empty", ""], ["a number", 17], ["an object", {}], ["upper case", "EUR"], ["with a space", "usd "], ["four letters", "usdx"]] as const) {
    rows = [row("cs_test_currency_unknown", currency)];
    is(`${what}: the list is unknown`, (await listSales(store)).state, "error");
  }

  part("A readable neighbor does not vouch for an unknown currency");
  rows = [row("cs_test_currency_known", "usd"), row("cs_test_currency_null", null)];
  is("one sale in dollars, one with no currency: unknown", (await listSales(store)).state, "error");

  part("Controls: what Stripe gave is kept, and the reads are the same");
  for (const currency of ["usd", "eur", "jpy", "brl"]) {
    rows = [row(`cs_test_currency_${currency}`, currency)];
    const before = reads;
    const listed = await listSales(store);
    is(`${currency}: listed with its own currency and amount`, listed.state === "ok" ? [listed.sales[0]?.currency, listed.sales[0]?.amount] : listed.state, [currency, 4900]);
    is(`${currency}: two reads of Stripe, as before`, reads - before, 2);
  }
  rows = [{ ...row("cs_test_currency_zero", "usd"), amount_total: 0 }];
  const free = await listSales(store);
  is("a known zero stays zero", free.state === "ok" ? free.sales[0]?.amount : free.state, 0);
  rows = [row("cs_test_currency_elsewhere", null, "another-store"), row("cs_test_currency_ours", "eur")];
  const other = await listSales(store);
  is("another store's checkout with no currency is not this store's sale, and does not hide this store's", other.state === "ok" ? other.sales.map((s) => [s.reference, s.currency]) : other.state, [["cs_test_currency_ours", "eur"]]);
  rows = [{ ...row("cs_test_currency_unpaid", null), status: "open", payment_status: "unpaid" }, row("cs_test_currency_paid", "usd")];
  const unpaid = await listSales(store);
  is("an unpaid checkout with no currency is not a sale, and does not hide the paid one", unpaid.state === "ok" ? unpaid.sales.map((s) => s.reference) : unpaid.state, ["cs_test_currency_paid"]);
}

main()
  .then(done)
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });
