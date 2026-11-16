/**
 * GET /api/v1/sales?email= and the Zapier search Find Order (378 [TB4]
 * complement WG (c); app/api/v1/sales/route.ts, lib/api-sales.ts sales,
 * zapier/index.js find_order): one buyer's sales, newest first, read from the
 * creator's own Stripe account with Stripe's own filter on the address the
 * buyer gave at checkout. What is checked, with a synthetic Stripe:
 *
 *   - Stripe is asked for that address only (customer_details[email]), and
 *     the answer is this store's sales of that buyer, in the fields of a page
 *     of sales;
 *   - it is paid for before Stripe is read, exactly as a page of sales is
 *     (API_SALES_UNITS): with too few requests left it is refused and Stripe
 *     is not asked;
 *   - an address that cannot be one is 400 invalid_email before Stripe is
 *     asked; a row of another buyer in Stripe's answer makes it unknown (502),
 *     never a sale of someone else;
 *   - the Zapier search: the sales found, nothing found for nobody, and a
 *     stop with the reason when the page read was another store's only
 *     (an empty page with a next), never "nothing found".
 */
import { GET as salesRead } from "@/app/api/v1/sales/route";
import { makeKey } from "@/lib/api-keys";
import { SALE_FIELDS } from "@/lib/api-sales";
import { allowanceUsed, takeAllowance } from "@/lib/store-allowance";
import { API_SALES_UNITS } from "@/lib/store-allowance-rules";
import { claimHandle, ensureStatsId, setStripeAccount, setSubscription, storeForEmail } from "@/lib/store";
import { paidPeriod } from "./billing-period-fixture";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";

// eslint-disable-next-line @typescript-eslint/no-require-imports
const app = require("../zapier/index.js") as {
  searches: Record<string, { operation: { perform: (z: Z, b: { authData: { api_key: string }; inputData: Record<string, unknown> }) => Promise<Record<string, unknown>[]>; inputFields: { key: string; required?: boolean }[]; sample: Record<string, unknown> } }>;
  beforeRequest: ((r: Req, z: Z, b: unknown) => Req)[];
  afterResponse: ((r: Res, z: Z) => Res)[];
};
type Req = { url: string; method?: string; params?: Record<string, string | number>; headers?: Record<string, string> };
type Res = { status: number; data: unknown; content: string };
type Z = { request: (r: Req) => Promise<Res>; errors: { Error: typeof ZapierError } };
class ZapierError extends Error {
  code: string;
  constructor(message: string, code: string) {
    super(message);
    this.code = code;
  }
}

const OWNER = "sales-by-email@example.com";
const HANDLE = "sales-by-email-shop";
const ACCOUNT = "acct_SalesByEmail01";
process.env.STRIPE_SECRET_KEY = "sk_test_sales_by_email_only";

let page: Record<string, unknown> = { object: "list", has_more: false, data: [] };
const asked: URL[] = [];
globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const url = new URL(String(input));
  if (url.origin !== "https://api.stripe.com" || url.pathname !== "/v1/checkout/sessions" || init?.method !== "GET" || new Headers(init.headers).get("Stripe-Account") !== ACCOUNT) throw new Error(`unexpected synthetic operation ${url}`);
  asked.push(url);
  return Response.json(page);
}) as typeof fetch;
console.error = () => {};

const session = (id: string, email: string, created: number, meta: Record<string, string> = {}) => ({
  id,
  object: "checkout.session",
  status: "complete",
  payment_status: "paid",
  mode: "payment",
  created,
  payment_intent: { id: `pi_${id}`, object: "payment_intent", created: created + 60, latest_charge: { id: `ch_${id}`, object: "charge", created: created + 60, amount_refunded: 0, disputed: false } },
  amount_total: 4900,
  currency: "usd",
  total_details: { amount_discount: 0 },
  customer_details: { email, name: "Dana Ortiz" },
  metadata: { store: HANDLE, product: "p_guide", title: "The Pantry Guide", ...meta },
});

function zFor(key: string): Z {
  const z: Z = {
    errors: { Error: ZapierError },
    request: async (raw: Req) => {
      let req: Req = { headers: {}, method: "GET", ...raw };
      for (const hook of app.beforeRequest) req = hook(req, z, { authData: { api_key: key }, inputData: {} });
      const url = new URL(req.url);
      for (const [name, value] of Object.entries(req.params ?? {})) url.searchParams.set(name, String(value));
      const response = await salesRead(new Request(url.toString(), { headers: req.headers }));
      const content = await response.text();
      let data: unknown = {};
      try {
        data = JSON.parse(content);
      } catch {
        data = {};
      }
      let res: Res = { status: response.status, data, content };
      for (const hook of app.afterResponse) res = hook(res, z);
      return res;
    },
  };
  return z;
}

async function main(): Promise<void> {
  redis.clear();
  await claimHandle(OWNER, HANDLE, "Sales By Email", "");
  await ensureStatsId(OWNER);
  await setSubscription(OWNER, { customerId: "cus_SalesByEmail1", subscriptionId: "sub_SalesByEmail1", active: true, tier: "pro", cycle: "month", period: paidPeriod() });
  await setStripeAccount(OWNER, ACCOUNT, true);
  const store = async () => (await storeForEmail(OWNER))!;
  const key = await makeKey((await store()).sid, "Synthetic reader");
  if (!key.ok) throw new Error("no synthetic key");
  const call = async (query: string) => {
    const res = await salesRead(new Request(`https://marktmorgen.com/api/v1/sales${query}`, { headers: { Authorization: `Bearer ${key.key}` } }));
    return { status: res.status, body: (await res.json()) as { data?: Record<string, unknown>[]; next?: string | null; error?: string } };
  };

  part("One buyer's sales, by Stripe's own filter on the address");
  page = { object: "list", has_more: false, data: [session("cs_test_newer0001", "dana@example.com", 1_790_100_000), session("cs_test_other0001", "dana@example.com", 1_790_050_000, { store: "someone-else" }), session("cs_test_older0001", "dana@example.com", 1_790_000_000)] };
  asked.length = 0;
  const before = await allowanceUsed(await store(), "api");
  const found = await call("?email=%20dana%40example.com%20");
  is("200: this store's two sales of that buyer, newest first, no next", [found.status, found.body.data?.map((s) => s.checkout_session), found.body.next], [200, ["cs_test_newer0001", "cs_test_older0001"], null]);
  is("Stripe asked once, for that address only", [asked.length, asked[0]?.searchParams.get("customer_details[email]")], [1, "dana@example.com"]);
  is("in the fields of a page of sales", Object.keys(found.body.data?.[0] ?? {}), [...SALE_FIELDS]);
  is("paid as a page of sales is", (await allowanceUsed(await store(), "api")) - before, API_SALES_UNITS);

  part("Refused before Stripe is asked");
  asked.length = 0;
  const bad = await call("?email=not%20an%20address");
  is("an address that cannot be one: 400 invalid_email, Stripe not asked", [bad.status, bad.body.error, asked.length], [400, "invalid_email", 0]);
  page = { object: "list", has_more: false, data: [session("cs_test_wrong0001", "someone@example.com", 1_790_100_000)] };
  const wrong = await call("?email=dana%40example.com");
  is("another buyer's sale in Stripe's answer: unknown, never sent as hers", [wrong.status, wrong.body.error], [502, "unavailable"]);

  part("The Zapier search, through the real route");
  const search = app.searches.find_order?.operation;
  is("Find Order asks for the buyer's email, its example in the fields of a sale", [search?.inputFields.map((f) => [f.key, f.required]), Object.keys(search?.sample ?? {}).sort()], [[["email", true]], [...SALE_FIELDS].sort()]);
  const auth = { api_key: key.key };
  page = { object: "list", has_more: false, data: [session("cs_test_newer0001", "Dana@Example.com", 1_790_100_000)] };
  const zfound = search ? await search.perform(zFor(key.key), { authData: auth, inputData: { email: "Dana@Example.com" } }) : [];
  is("the order found", [zfound.length, zfound[0]?.checkout_session], [1, "cs_test_newer0001"]);
  page = { object: "list", has_more: false, data: [] };
  is("nobody is nothing found", search ? await search.perform(zFor(key.key), { authData: auth, inputData: { email: "nobody@example.com" } }) : null, []);
  page = { object: "list", has_more: true, data: [session("cs_test_theirs001", "dana@example.com", 1_790_100_000, { store: "someone-else" })] };
  const unsure = search ? await search.perform(zFor(key.key), { authData: auth, inputData: { email: "dana@example.com" } }).then(() => "", (e: ZapierError) => e.code) : "";
  is("a page of another store's only, with more after it: stopped with the reason, never nothing found", unsure, "not_read_whole");

  part("With too few requests left, refused and Stripe not asked");
  for (;;) if (!(await takeAllowance(await store(), "api")).ok) break;
  asked.length = 0;
  const spent = await call("?email=dana%40example.com");
  is("429, Stripe not asked", [spent.status, asked.length], [429, 0]);

  done();
}

void main();
