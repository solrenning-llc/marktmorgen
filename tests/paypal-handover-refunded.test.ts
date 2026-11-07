/**
 * Claude 5's MEDIUM on #2909 (head 3a9f0b9e): the hand-over list's retry (handOverAgain) handed over an order PayPal
 * had already refunded in full. The refund watch saw REFUNDED, wrote the refund mark and, with nothing granted yet,
 * took the order off its watch; nothing looked at it again, and the retry then granted the product, sent the receipt,
 * counted the order and told the webhooks "sale.completed" after "refund.issued". Now the retry reads the order's
 * refund mark exactly before handing it over: refunded, it leaves the list with nothing handed over; unknown, it is
 * kept; not refunded, it is handed over (a refund seen later takes it back, as before).
 *
 * Synthetic only: a stand-in for PayPal's API, the Redis stub, the real return route and the real sweep.
 */
import { TEST_CONSENT } from "./digital-consent-fixture";
import { claimHandle, ensureStatsId, addProduct, setProductLink, setSubscription, setPayPalSeller, storeForEmail, type Store } from "@/lib/store";
import { readListing, STORE_PAGE_SIZE } from "@/lib/catalog";
import { openOrder, readPaid } from "@/lib/paypal-sales";
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
const orderId = (n: number) => `5O190127TN36471${String(n).padStart(2, "0")}`;

function completed(order: string, value: string, email: string): Record<string, unknown> {
  return {
    id: order,
    status: "COMPLETED",
    payer: { email_address: email, payer_id: "QYR5Z8XDVJNXQ" },
    purchase_units: [{ reference_id: "x", payee: { merchant_id: SELLER }, payments: { captures: [{ id: `3C679366HH9087${order.slice(-2)}`, status: "COMPLETED", amount: { currency_code: "USD", value } }] } }],
  };
}

let buyerFor = "a@example.com";
/** Captures PayPal answers as refunded in full. */
const refunded = new Set<string>();
const captureOf = (order: string) => `3C679366HH9087${order.slice(-2)}`;
/** Orders the sweep handed over (its `cleared`), since the last reset. */
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
  if (cap && method === "GET") return json({ id: cap, status: refunded.has(cap) ? "REFUNDED" : "COMPLETED" });
  return json({ name: "RESOURCE_NOT_FOUND" }, 404);
}) as typeof fetch;

const returnFor = (store: Store, order: string) =>
  paypalReturn(new NextRequest(`https://marktmorgen.com/api/store/paypal/return?store=${store.handle}&token=${order}`, { headers: { host: "marktmorgen.com", "x-forwarded-for": `198.51.100.${made}` } }));


const realNow = Date.now.bind(Date);
let ahead = 0;
Date.now = () => realNow() + ahead;
const handOverKey = (statsId: string) => `nl:ppsell:handover:${statsId}`;
type Commands = (string | number)[][];
const single = (c: Commands, op: string, key: string) => c.length === 1 && c[0][0] === op && c[0][1] === key;

/** One PayPal purchase through the real return route, with `fault` on while the return runs. */
async function buy(store: Store, productId: string, buyer: string, fault: (c: Commands) => Promise<unknown[]> | null): Promise<string> {
  const product = (await readListing(store, productId))!;
  const opened = await openOrder(store, product, "https://marktmorgen.com", { digitalConsent: TEST_CONSENT });
  if (!opened.ok) throw new Error(`no order: ${opened.reason}`);
  buyerFor = buyer;
  const pipeline = redis.pipeline.bind(redis);
  redis.pipeline = (async (commands: Commands) => fault(commands) ?? pipeline(commands)) as typeof redis.pipeline;
  try {
    await returnFor(store, opened.order);
  } finally {
    redis.pipeline = pipeline;
  }
  return opened.order;
}

async function main(): Promise<void> {
  redis.clear();
  console.error = () => {};
  process.env.RESEND_API_KEY = "re_test_handover_refunded";
  delete process.env.PAYPAL_ENV;
  process.env.PAYPAL_PARTNER_CLIENT_ID = PARTNER_CLIENT;
  process.env.PAYPAL_PARTNER_SECRET = "EPpartnerSecret0123456789";
  process.env.PAYPAL_PARTNER_MERCHANT_ID = "PARTNERMERCH01";
  process.env.PAYPAL_BN_CODE = "NimbusLabs_SP";

  await claimHandle("owner@example.com", "harbor", "Harbor Kitchen", "");
  await ensureStatsId("owner@example.com");
  await setSubscription("owner@example.com", { customerId: "cus_Owner00001", subscriptionId: "sub_Owner00001", active: true, period: paidPeriod() });
  // More products than one page, so the product is read by its own listing key (the one the fault below times out).
  for (let i = 0; i < STORE_PAGE_SIZE + 1; i += 1) {
    const more = await addProduct("owner@example.com", `Recipe ${i}`, "", "9", null);
    if (!more.ok) throw new Error(`no product ${i}: ${JSON.stringify(more)}`);
  }
  const added = await addProduct("owner@example.com", "Sourdough Guide", "", "49", null);
  if (!added.ok) throw new Error("no product");
  await setProductLink("owner@example.com", added.product.id, "https://example.com/guide");
  await setPayPalSeller("owner@example.com", SELLER);
  const store = (await storeForEmail("owner@example.com"))!;
  const id = added.product.id;
  const statsId = store.statsId!;
  const listingKey = `nl:catalog:${store.catalog.id}:l:${id}`;
  const fresh = async () => (await storeForEmail("owner@example.com"))!;
  const owned = async (buyer: string) => (await importedFor(await fresh(), buyer)).length;
  const queued = async () => (await redis.pipeline([["ZRANGEBYSCORE", handOverKey(statsId), "-inf", "+inf"]]))[0] as string[];
  const refundMark = async (order: string) => (await redis.pipeline([["ZSCORE", `nl:ppsell:refunded:${statsId}`, order]]))[0];
  const sweepLater = async () => {
    ahead += 3_600_000;
    swept += (await sweepPayPal(await fresh(), Date.now() + 10_000)).cleared;
  };
  const timeout = async () => {
    throw new Error("Synthetic: Redis timed out");
  };
  const slowReturn = (c: Commands) => (single(c, "GET", listingKey) ? timeout() : null);

  part("Control: handed over by the sweep, then refunded: the refund takes it back");
  swept = 0;
  const later = await buy(store, id, "later@example.com", slowReturn);
  await sweepLater();
  is("handed over once by the sweep", [await owned("later@example.com"), swept], [1, 1]);
  refunded.add(captureOf(later));
  for (let i = 0; i < 4; i += 1) await sweepLater();
  is("the refund is marked and the purchase taken back", [await refundMark(later) !== null, await owned("later@example.com")], [true, 0]);

  part("The return could not read the product, then the creator refunded: the retry never hands it over");
  swept = 0;
  const first = await buy(store, id, "refunded@example.com", slowReturn);
  is("paid, nothing handed over, in the hand-over list", [Boolean(await readPaid(first)), await owned("refunded@example.com"), (await queued()).includes(first)], [true, 0, true]);
  refunded.add(captureOf(first));
  await sweepLater();
  is("the refund is marked", await refundMark(first) !== null, true);
  is("nothing handed over: no purchase, nothing counted as cleared", [await owned("refunded@example.com"), swept], [0, 0]);
  is("and it left the hand-over list", (await queued()).includes(first), false);
  await sweepLater();
  is("later sweeps hand nothing over either", [await owned("refunded@example.com"), swept], [0, 0]);

  part("The refund already marked while the product could not be read for hours: the retry never hands it over");
  swept = 0;
  const marked = await buy(store, id, "marked@example.com", slowReturn);
  await redis.pipeline([["ZADD", `nl:ppsell:refunded:${statsId}`, String(Math.floor(Date.now() / 1000)), marked]]);
  await sweepLater();
  is("nothing handed over, out of the list", [await owned("marked@example.com"), swept, (await queued()).includes(marked)], [0, 0, false]);

  for (const [label, reply] of [
    ["the text \"abc\"", ["abc"]],
    ["a number", [7]],
    ["no reply at all", []],
  ] as [string, unknown[]][]) {
    part(`The refund mark read as ${label}: kept in the list, nothing handed over; read healthy, handed over once`);
    swept = 0;
    const buyer = `mark-${label.replace(/\W+/g, "-")}@example.com`;
    const order = await buy(store, id, buyer, slowReturn);
    const pipeline = redis.pipeline.bind(redis);
    redis.pipeline = (async (c: Commands) => (single(c, "ZSCORE", `nl:ppsell:refunded:${statsId}`) ? [...reply] : pipeline(c))) as typeof redis.pipeline;
    try {
      await sweepLater();
    } finally {
      redis.pipeline = pipeline;
    }
    is("kept, nothing handed over", [(await queued()).includes(order), await owned(buyer)], [true, 0]);
    await sweepLater();
    is("the next healthy sweep hands it over once", [await owned(buyer), swept], [1, 1]);
  }

  done();
}

main().catch((error) => {
  console.log(String(error?.stack ?? error));
  process.exit(1);
});
