/**
 * Rule 24 in PayPal sales (lib/paypal-sales.ts):
 *
 *   - readOpened, in the watch of orders PayPal has not settled (watchPayPal): the order's own record read in another
 *     shape is unknown, never "expired". The order stays watched, so one the buyer paid but whose capture was never
 *     written down (the buyer never came back) is still handed over once the read heals, instead of being taken off
 *     the only sweep that would ever hand it over;
 *   - paypalOrdersOf, for the copy of a person's data (lib/person-copy.ts): a reply cut short or of another shape, or a
 *     paid record that does not read, throws, never a copy handed over without their PayPal orders.
 *
 * Synthetic only: a stand-in for PayPal and the in-memory Redis.
 */
import { TEST_CONSENT } from "./digital-consent-fixture";
import { claimHandle, ensureStatsId, addProduct, setProductLink, setSubscription, setPayPalSeller, storeForEmail, type Store } from "@/lib/store";
import { readListing } from "@/lib/catalog";
import { openOrder, paypalOrdersOf, readPaid, watchPayPal } from "@/lib/paypal-sales";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";
import { paidPeriod } from "./billing-period-fixture";

const PARTNER_CLIENT = "AZpartnerClientId0123456789";
const SELLER = "7KNGBPH2U58GQ";
const orders = new Map<string, Record<string, unknown>>();
let made = 0;
const orderId = (n: number) => `5O190127TN36471${String(n).padStart(2, "0")}`;

function completed(order: string, value: string, email: string): Record<string, unknown> {
  return {
    id: order,
    status: "COMPLETED",
    payer: { email_address: email, payer_id: "QYR5Z8XDVJNXQ" },
    purchase_units: [{ reference_id: "x", payee: { merchant_id: SELLER }, payments: { captures: [{ id: `3C679366HH9087${order.slice(-2)}`, status: "COMPLETED", amount: { currency_code: "USD", value } }] } }],
  };
}

const buyerFor = "buyer@example.com";
globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const url = new URL(String(input));
  const json = (v: unknown, status = 200) => new Response(JSON.stringify(v), { status });
  if (url.hostname === "api.resend.com") return json({ id: "e" });
  if (url.hostname !== "api-m.paypal.com") return json({ error: "unexpected" }, 404);
  const method = init?.method ?? "GET";
  if (url.pathname === "/v1/oauth2/token") return json({ access_token: "A21AApartner", token_type: "Bearer", expires_in: 32400 });
  if (url.pathname === "/v2/checkout/orders" && method === "POST") {
    made += 1;
    const id = orderId(made);
    orders.set(id, { id, status: "PAYER_ACTION_REQUIRED" });
    return json({ id, status: "PAYER_ACTION_REQUIRED", links: [{ href: `https://www.paypal.com/checkoutnow?token=${id}`, rel: "payer-action", method: "GET" }] });
  }
  const capture = /^\/v2\/checkout\/orders\/([A-Z0-9]+)\/capture$/.exec(url.pathname)?.[1];
  if (capture && method === "POST") {
    const body = completed(capture, "49.00", buyerFor);
    orders.set(capture, body);
    return json(body, 201);
  }
  const read = /^\/v2\/checkout\/orders\/([A-Z0-9]+)$/.exec(url.pathname)?.[1];
  if (read && method === "GET") return orders.has(read) ? json(orders.get(read)) : json({ name: "RESOURCE_NOT_FOUND" }, 404);
  const cap = /^\/v2\/payments\/captures\/([A-Z0-9]+)$/.exec(url.pathname)?.[1];
  if (cap && method === "GET") return json({ id: cap, status: "COMPLETED" });
  return json({ name: "RESOURCE_NOT_FOUND" }, 404);
}) as typeof fetch;

async function main(): Promise<void> {
  redis.clear();
  process.env.RESEND_API_KEY = "re_test_paypal_order_reads";
  delete process.env.PAYPAL_ENV;
  process.env.PAYPAL_PARTNER_CLIENT_ID = PARTNER_CLIENT;
  process.env.PAYPAL_PARTNER_SECRET = "EPpartnerSecret0123456789";
  process.env.PAYPAL_PARTNER_MERCHANT_ID = "PARTNERMERCH01";
  process.env.PAYPAL_BN_CODE = "NimbusLabs_SP";
  await claimHandle("owner@example.com", "harbor", "Harbor Kitchen", "");
  await ensureStatsId("owner@example.com");
  await setSubscription("owner@example.com", { customerId: "cus_Owner00001", subscriptionId: "sub_Owner00001", active: true, period: paidPeriod() });
  const added = await addProduct("owner@example.com", "Sourdough Guide", "", "49", null);
  if (!added.ok) throw new Error("no product");
  await setProductLink("owner@example.com", added.product.id, "https://example.com/guide");
  await setPayPalSeller("owner@example.com", SELLER);
  const store = (await storeForEmail("owner@example.com")) as Store;
  const product = (await readListing(store, added.product.id))!;
  const pending = `nl:ppsell:pending:${store.statsId}`;
  type Batch = (string | number)[][];
  const pipeline = redis.pipeline.bind(redis);

  part("The watch: an order's own record read in another shape is not \"expired\"");
  const opened = await openOrder(store, product, "https://marktmorgen.com", { digitalConsent: TEST_CONSENT });
  if (!opened.ok) throw new Error(`no order: ${opened.reason}`);
  const order = opened.order;
  // Paid at PayPal, and the buyer never came back: only the watch can hand it over.
  orders.set(order, completed(order, "49.00", buyerFor));
  await pipeline([["ZADD", pending, String(Math.floor(Date.now() / 1000)), order]]);
  const handed: string[] = [];
  const on = { handOver: async (paid: { order?: string }) => { handed.push(String(paid.order ?? "paid")); }, dropStart: async () => {} };
  const orderGet = (batch: Batch) => batch.length === 1 && batch[0][0] === "GET" && batch[0][1] === `nl:ppsell:o:${order}`;
  for (const [label, reply] of [["cut short", []], ["a number", [7]], ["an object", [{ s: store.statsId }]], ["a list", [["x"]]]] as [string, unknown[]][]) {
    redis.pipeline = (async (batch: Batch) => (orderGet(batch) ? reply : pipeline(batch))) as typeof redis.pipeline;
    try {
      await watchPayPal(store, Date.now() + 10_000, on);
    } finally {
      redis.pipeline = pipeline;
    }
    is(`${label}: the order is still watched`, (await pipeline([["ZSCORE", pending, order]]))[0] !== null, true);
    is(`(${label}: nothing handed over yet)`, handed.length, 0);
  }
  await watchPayPal(store, Date.now() + 10_000, on);
  is("once the read heals, the paid order is written down and handed over", [Boolean(await readPaid(order)), handed.length], [true, 1]);

  part("The copy of a person's data: PayPal orders read exactly");
  const mine = await paypalOrdersOf(store.statsId, [product.id], buyerFor);
  is("read exactly, the person's paid order", mine.length, 1);
  const own = (batch: Batch) => batch.every((c) => c[0] === "SMEMBERS" && String(c[1]).startsWith("nl:ppsell:own:"));
  const paidGet = (batch: Batch) => batch.length === 1 && batch[0][0] === "GET" && batch[0][1] === `nl:ppsell:paid:${order}`;
  for (const [label, pick, reply] of [
    ["the orders cut short", own, []],
    ["the orders as a number", own, [7]],
    ["an order id that is not text", own, [[1]]],
    ["the paid record cut short", paidGet, []],
    ["the paid record not JSON", paidGet, ["{not json"]],
  ] as [string, (b: Batch) => boolean, unknown[]][]) {
    redis.pipeline = (async (batch: Batch) => (pick(batch) ? reply : pipeline(batch))) as typeof redis.pipeline;
    let outcome: string;
    try {
      outcome = JSON.stringify(await paypalOrdersOf(store.statsId, [product.id], buyerFor));
    } catch {
      outcome = "threw";
    } finally {
      redis.pipeline = pipeline;
    }
    is(`${label}: throws, never a copy without the order`, outcome, "threw");
  }
}

main().then(done, (error) => {
  console.error(error);
  process.exit(1);
});
