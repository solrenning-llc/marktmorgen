/**
 * 630 [HN6](19) unit 1: GET /api/v1/sales, the store's paid checkouts read
 * from the creator's own Stripe account, in the shape of the sale.completed
 * webhook, only this store's settled ones, only while it can sell, with
 * Stripe's own cursor. Synthetic Stripe answers only.
 */
import { GET } from "@/app/api/v1/sales/route";
import { makeKey } from "@/lib/api-keys";
import { SALES_PAGE, saleKind } from "@/lib/api-sales";
import { claimHandle, ensureStatsId, setStripeAccount, setSubscription, storeForEmail } from "@/lib/store";
import { paidPeriod } from "./billing-period-fixture";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";

const OWNER = "api-sales@example.com";
const HANDLE = "api-sales-shop";
const ACCOUNT = "acct_ApiSalesTest01";
process.env.STRIPE_SECRET_KEY = "sk_test_api_sales_stand_in";

let pages: Record<string, unknown>[] = [];
const asked: URL[] = [];
globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const url = new URL(String(input));
  if (url.origin !== "https://api.stripe.com" || url.pathname !== "/v1/checkout/sessions" || init?.method !== "GET" || new Headers(init.headers).get("Stripe-Account") !== ACCOUNT) {
    throw new Error(`unexpected synthetic operation ${url}`);
  }
  asked.push(url);
  return Response.json(pages.shift() ?? { error: "no page" });
}) as typeof fetch;

const session = (id: string, extra: Record<string, unknown> = {}, meta: Record<string, string> = {}) => ({
  id,
  object: "checkout.session",
  status: "complete",
  payment_status: "paid",
  mode: "payment",
  created: 1_790_000_000,
  amount_total: 4900,
  currency: "usd",
  total_details: { amount_discount: 500 },
  customer_details: { email: "dana@example.com", name: "Dana Ortiz" },
  custom_fields: [{ key: "q1", text: { value: "a private answer" } }],
  metadata: { store: HANDLE, product: "p_guide", title: "The Pantry Guide", option: "full", utm_source: "newsletter", ...meta },
  ...extra,
});

async function main(): Promise<void> {
  redis.clear();
  await claimHandle(OWNER, HANDLE, "API Sales Shop", "");
  await ensureStatsId(OWNER);
  let store = (await storeForEmail(OWNER))!;
  const key = await makeKey(store.sid, "Synthetic reader");
  if (!key.ok) throw new Error("no synthetic key");
  const call = async (query = "") => {
    const res = await GET(new Request(`https://marktmorgen.com/api/v1/sales${query}`, { headers: { Authorization: `Bearer ${key.key}` } }));
    return { status: res.status, body: (await res.json()) as Record<string, unknown> };
  };

  part("Only while the store can take payments, as the studio");
  await setSubscription(OWNER, { customerId: "cus_ApiSales1", subscriptionId: "sub_ApiSales1", active: true, tier: "pro", cycle: "month", period: paidPeriod() });
  const closed = await call();
  is("no Stripe account: refused with the reason, Stripe not asked", [closed.status, (closed.body as { error?: string }).error, asked.length], [409, "not_selling", 0]);
  await setStripeAccount(OWNER, ACCOUNT, false);
  const notEnabled = await call();
  is("charges not enabled on it yet: refused the same way", [notEnabled.status, asked.length], [409, 0]);
  await setStripeAccount(OWNER, ACCOUNT, true);
  store = (await storeForEmail(OWNER))!;

  part("A page of sales");
  pages = [{
    object: "list",
    has_more: true,
    data: [
      session("cs_test_one"),
      session("cs_test_sub", { mode: "subscription" }, { trial_days: "7", product: "p_club", title: "" }),
      session("cs_test_open", { status: "open", payment_status: "unpaid" }),
      session("cs_test_other", {}, { store: "someone-else" }),
      session("cs_test_tip", {}, { kind: "tip" }),
    ],
  }];
  const first = await call();
  const data = (first.body as { data: Record<string, unknown>[] }).data;
  is("answered", first.status, 200);
  is("only this store's settled checkouts, newest first", data.map((s) => s.checkout_session), ["cs_test_one", "cs_test_sub", "cs_test_tip"]);
  is("in the shape of sale.completed", data[0], {
    checkout_session: "cs_test_one",
    kind: "one_time",
    product: { id: "p_guide", title: "The Pantry Guide" },
    option: "full",
    amount_cents: 4900,
    discount_cents: 500,
    currency: "usd",
    buyer: { email: "dana@example.com", name: "Dana Ortiz" },
    paid_at: new Date(1_790_000_000_000).toISOString(),
    trial: false,
    source: { utm_source: "newsletter", utm_medium: null, utm_campaign: null, utm_content: null, site: null },
  });
  is("a membership with its trial, a tip as a tip", [data[1].kind, data[1].trial, data[2].kind], ["membership", true, "tip"]);
  is("what the buyer typed at checkout is never sent", JSON.stringify(first.body).includes("a private answer"), false);
  is("refunds are not read per sale, and it says so", (first.body as { refunds_checked: unknown }).refunds_checked, false);
  is("the next cursor is Stripe's own: the last checkout of its page", (first.body as { next: unknown }).next, "cs_test_tip");
  is("one request to Stripe, its own most per page", [asked.length, asked[0].searchParams.get("limit")], [1, String(SALES_PAGE)]);

  part("Going on with the cursor");
  pages = [{ object: "list", has_more: false, data: [session("cs_test_other2", {}, { store: "someone-else" })] }];
  const second = await call("?cursor=cs_test_tip");
  is("Stripe asked from after the cursor", asked[1].searchParams.get("starting_after"), "cs_test_tip");
  is("a page with none of this store's: empty, and the end", [(second.body as { data: unknown[] }).data, (second.body as { next: unknown }).next], [[], null]);
  pages = [{ object: "list", has_more: false, data: [] }];
  await call("?cursor=not-a-cursor");
  is("a cursor that is not Stripe's is ignored", asked[2].searchParams.get("starting_after"), null);

  part("An answer that cannot be read whole is unknown, never no sales");
  for (const bad of [{ data: null, has_more: false }, { data: [], has_more: "no" }, { data: [null], has_more: false }, []]) {
    pages = [bad as Record<string, unknown>];
    const r = await call();
    is(`refused: ${JSON.stringify(bad)}`, [r.status, (r.body as { error?: string }).error], [502, "unavailable"]);
  }

  part("Kinds");
  is("as sale.completed names them", [saleKind({ metadata: { kind: "call" } }), saleKind({ metadata: { kind: "plan" }, mode: "subscription" }), saleKind({ mode: "subscription" }), saleKind({ mode: "payment" })], ["call", "payment_plan", "membership", "one_time"]);

  done();
}

void main();
