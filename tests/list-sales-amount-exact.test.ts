import { readFileSync } from "node:fs";
import { done, is, part } from "./check";
import { store as redis } from "./redis-stub";
import { paidPeriod } from "./billing-period-fixture";

// The studio's sales list and the people page's latest buyers show what each
// checkout cost, read from the creator's Stripe account (lib/store-checkout.ts,
// listSales). An amount Stripe did not give as a whole, non-negative number of
// the currency's smallest unit is unknown: it is never shown as "$0.00" and
// never shown as the odd figure it was (rule 24; coordinator C1-20261109-1603-TODOS-71).
// Synthetic Stripe replies only; nothing leaves this process.

const BASE = "http://127.0.0.1:4998";
const MISSING = Symbol("missing");

async function main(): Promise<void> {
  const previousFetch = globalThis.fetch;
  const previousKey = process.env.STRIPE_SECRET_KEY;
  const previousApi = process.env.STRIPE_CONNECT_API_BASE;
  process.env.STRIPE_SECRET_KEY = "sk_test_list_sales_amount_only_a_stand_in";
  process.env.STRIPE_CONNECT_API_BASE = BASE;
  // Handed back as already parsed, so a value JSON cannot carry (NaN) reaches the reader too.
  let rows: Record<string, unknown>[] = [];
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input));
    if (url.origin !== BASE || (init?.method ?? "GET") !== "GET") {
      throw new Error("Only synthetic order reads are allowed");
    }
    const body = url.pathname === "/v1/checkout/sessions" ? { data: rows }
      : url.pathname === "/v1/payment_intents" ? { data: [] }
      : null;
    if (body === null) throw new Error("Unexpected synthetic endpoint");
    const response = new Response("{}", { status: 200 });
    Object.defineProperty(response, "json", { value: async () => body });
    return response;
  }) as typeof fetch;
  try {
    redis.clear();
    const { claimHandle, setStripeAccount, setSubscription, storeForEmail } = await import("@/lib/store");
    const { listSales } = await import("@/lib/store-checkout");
    const email = "list-sales-amount@example.test";
    await claimHandle(email, "listsalesamount", "Sales amount proof", "");
    await setStripeAccount(email, "acct_fixture047", true);
    await setSubscription(email, { customerId: "cus_ListSalesAmount1", subscriptionId: "sub_ListSalesAmount1", active: true, period: paidPeriod() });
    const store = (await storeForEmail(email))!;
    const now = Math.floor(Date.now() / 1000);
    const row = (id: string, amount: unknown, at: number): Record<string, unknown> => ({
      id, status: "complete", payment_status: "paid", created: at, currency: "usd",
      metadata: { store: store.handle, title: `Synthetic ${id}` },
      customer_details: { email: `${id}@example.test` },
      ...(amount === MISSING ? {} : { amount_total: amount }),
    });

    part("Control: every amount known, nothing changes");
    rows = [row("cs_known_a", 1200, now - 1), row("cs_known_b", 0, now - 2), row("cs_known_c", 4900, now - 3)];
    const known = await listSales(store);
    if (known.state !== "ok") throw new Error(`Expected a readable list, got ${known.state}`);
    is("all three sales are listed", known.sales.map((s) => s.reference), ["cs_known_a", "cs_known_b", "cs_known_c"]);
    is("each known amount is kept exactly, in cents", known.sales.map((s) => s.amount), [1200, 0, 4900]);
    is("a known zero (a free order) stays a number, not unknown", typeof known.sales[1].amount, "number");

    part("An amount Stripe did not give as a whole number of cents is unknown, never $0.00 or the odd figure");
    const odd: [string, unknown][] = [
      ["missing", MISSING],
      ["null", null],
      ["a string \"123\"", "123"],
      ["-1", -1],
      ["1.5", 1.5],
      ["NaN", Number.NaN],
      ["Infinity", Number.POSITIVE_INFINITY],
      ["2^53, past a safe integer", 2 ** 53],
    ];
    for (const [label, amount] of odd) {
      rows = [row("cs_odd_amount", amount, now - 1), row("cs_known_neighbor", 2500, now - 2)];
      const list = await listSales(store);
      is(`${label}: the list still reads`, list.state, "ok");
      if (list.state !== "ok") continue;
      const sale = list.sales.find((s) => s.reference === "cs_odd_amount");
      is(`${label}: the sale is still listed`, sale !== undefined, true);
      // `is` compares through JSON, where NaN and null look alike: compare identity instead.
      is(`${label}: its amount is unknown (null), not 0 nor the odd value`, sale?.amount === null, true);
      const neighbor = list.sales.find((s) => s.reference === "cs_known_neighbor");
      is(`${label}: the known sale beside it keeps its exact amount`, neighbor?.amount === 2500, true);
    }

    part("Both screens say an unknown amount is unknown, in a status region, and never format it");
    for (const file of ["app/studio/page.tsx", "app/studio/people/page.tsx"]) {
      const source = readFileSync(file, "utf8");
      const rendering = source.match(/amount === null \?[\s\S]{0,400}?formatMoney\(\w+\.amount, \w+\.currency\)/)?.[0] ?? "";
      is(`${file}: the amount is checked for unknown before it is formatted`, rendering !== "", true);
      is(`${file}: the unknown amount is said in words`, rendering.includes("Amount could not be loaded"), true);
      is(`${file}: the words sit in a status region`, /role="status"/.test(rendering), true);
    }

    done();
  } finally {
    globalThis.fetch = previousFetch;
    if (previousKey === undefined) delete process.env.STRIPE_SECRET_KEY; else process.env.STRIPE_SECRET_KEY = previousKey;
    if (previousApi === undefined) delete process.env.STRIPE_CONNECT_API_BASE; else process.env.STRIPE_CONNECT_API_BASE = previousApi;
  }
}
void main();
