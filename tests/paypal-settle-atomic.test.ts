/**
 * A PayPal payment written down is never left outside every list (rules 24 and 30; Claude 5's triage of the money
 * section of the tolerant-reads inventory, 9 November 2026).
 *
 * settle (lib/paypal-sales.ts) wrote the paid record with a SET NX and then, in a second pipeline, put the order in the
 * hand-over list, the refund watch, the buyer's own payments and the store's sales, and took it off pending. When that
 * second pipeline did not reach Redis (an instant of slowness), or the SET's answer was lost on the way back, the paid
 * record stood with the order in no list: every later try saw the SET NX refused and wrote nothing, and the pending
 * sweep, seeing the paid record, took the order off pending too. The buyer had paid and was never handed anything; the
 * sale was missing from the store's numbers and its refund was never watched.
 *
 * Synthetic only: a stand-in for PayPal's API, the Redis stub, the real return route and the real sweep (what it
 * hands over counted by its own `cleared`).
 */
import { TEST_CONSENT } from "./digital-consent-fixture";
import { claimHandle, ensureStatsId, addProduct, setProductLink, setSubscription, setPayPalSeller, storeForEmail, type Store } from "@/lib/store";
import { readListing } from "@/lib/catalog";
import { handOverKey, openOrder, ownKey, readPaid } from "@/lib/paypal-sales";
import { sweepPayPal } from "@/lib/paypal-delivery";
import { importedFor } from "@/lib/imported-purchases";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";
import { paidPeriod } from "./billing-period-fixture";
import { NextRequest } from "next/server";
import { GET as paypalReturn } from "@/app/api/store/paypal/return/route";

const PARTNER_CLIENT = "AZpartnerClientId0123456789";
const SELLER = "7KNGBPH2U58GQ";
const orders = new Map<string, Record<string, unknown>>();
let made = 0;
const orderId = (n: number) => `5O190127TN36472${String(n).padStart(2, "0")}`;

function completed(order: string, value: string, email: string): Record<string, unknown> {
  return {
    id: order,
    status: "COMPLETED",
    payer: { email_address: email, payer_id: "QYR5Z8XDVJNXQ" },
    purchase_units: [{ reference_id: "x", payee: { merchant_id: SELLER }, payments: { captures: [{ id: `3C679366HH9088${order.slice(-2)}`, status: "COMPLETED", amount: { currency_code: "USD", value } }] } }],
  };
}

let buyerFor = "a@example.com";
let swept = 0;
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

const returnFor = (store: Store, order: string) =>
  paypalReturn(new NextRequest(`https://marktmorgen.com/api/store/paypal/return?store=${store.handle}&token=${order}`, { headers: { host: "marktmorgen.com", "x-forwarded-for": `198.51.100.${made}` } }));

const realNow = Date.now.bind(Date);
let ahead = 0;
Date.now = () => realNow() + ahead;
type Commands = (string | number)[][];
type Pipeline = (commands: Commands) => Promise<unknown[]>;
const timeout = () => new Error("Synthetic: Redis timed out");

/**
 * How Redis fails around the paid record while the return runs ("none": it does not):
 *  - "after": every request after the paid record exists never reaches Redis (nothing of it is applied);
 *  - "lost": the request that writes the paid record is applied, but its answer is lost on the way back;
 *  - "shape": that request is applied and answers in a shape not known (rule 24): unknown, never "written here".
 */
type Fault = "none" | "after" | "lost" | "shape";

async function buy(store: Store, productId: string, buyer: string, fault: Fault): Promise<string> {
  const product = (await readListing(store, productId))!;
  const opened = await openOrder(store, product, "https://marktmorgen.com", { digitalConsent: TEST_CONSENT });
  if (!opened.ok) throw new Error(`no order: ${opened.reason}`);
  buyerFor = buyer;
  const paidKey = `nl:ppsell:paid:${opened.order}`;
  const pipeline: Pipeline = redis.pipeline.bind(redis);
  const exists = async () => (await pipeline([["EXISTS", paidKey]]))[0] === 1;
  redis.pipeline = (async (commands: Commands) => {
    const before = await exists();
    if (fault === "after" && before) throw timeout();
    const replies = await pipeline(commands);
    if (fault === "lost" && !before && (await exists())) throw timeout();
    if (fault === "shape" && !before && (await exists())) return [{ result: replies[0] }];
    return replies;
  }) as typeof redis.pipeline;
  try {
    await returnFor(store, opened.order);
  } catch {
    // The return may fail outright while Redis does; what matters is what is left written.
  } finally {
    redis.pipeline = pipeline;
  }
  return opened.order;
}

async function main(): Promise<void> {
  redis.clear();
  console.error = () => {};
  process.env.RESEND_API_KEY = "re_test_settle_atomic";
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
  const store = (await storeForEmail("owner@example.com"))!;
  const id = added.product.id;
  const statsId = store.statsId!;
  const fresh = async () => (await storeForEmail("owner@example.com"))!;
  const owned = async (buyer: string) => (await importedFor(await fresh(), buyer)).length;
  const members = async (key: string) => (await redis.pipeline([["ZRANGEBYSCORE", key, "-inf", "+inf"]]))[0] as string[];
  const sweepLater = async () => {
    ahead += 3_600_000;
    swept += (await sweepPayPal(await fresh(), Date.now() + 10_000)).cleared;
  };
  /** Where a paid order stands: in the hand-over list, the refund watch, the store's sales, the buyer's payments, off pending. */
  const lists = async (order: string, buyer: string) => [
    (await members(handOverKey(statsId))).includes(order) || (await owned(buyer)) === 1,
    (await members(`nl:ppsell:watch:${statsId}`)).includes(order),
    (await members(`nl:ppsell:sales:${statsId}`)).includes(order),
    ((await redis.pipeline([["SMEMBERS", ownKey(statsId, buyer, id)]]))[0] as string[]).includes(order),
    (await members(`nl:ppsell:pending:${statsId}`)).includes(order),
  ];

  part("Healthy control: written down, in every list, handed over once");
  swept = 0;
  const healthy = await buy(store, id, "healthy@example.com", "none");
  is("handed over on the return", await owned("healthy@example.com"), 1);
  is("owed or handed over, watched, counted, the buyer's, off pending", await lists(healthy, "healthy@example.com"), [true, true, true, true, false]);

  for (const [fault, label] of [
    ["after", "Redis does not answer anything after the paid record is written"],
    ["lost", "the paid record's write is applied but its answer is lost"],
    ["shape", "the paid record's write is applied and answers in a shape not known"],
  ] as [Fault, string][]) {
    part(`Claude 5: ${label}`);
    swept = 0;
    const buyer = `${fault}@example.com`;
    const order = await buy(store, id, buyer, fault);
    is("the payment is written down", Boolean(await readPaid(order)), true);
    is("and it stands in every list all the same (owed, watched, counted, the buyer's, off pending)", await lists(order, buyer), [true, true, true, true, false]);
    await sweepLater();
    await sweepLater();
    is("the sweeps hand it over, once", [await owned(buyer), swept], [1, 1]);
    is("and nothing stays owed", (await members(handOverKey(statsId))).includes(order), false);
  }

  done();
}

main().catch((error) => {
  console.log(String(error?.stack ?? error));
  process.exit(1);
});
