/**
 * The two MEDIUMs of the reviews of #2909 at 1165087a that the PR's own path leaves open (Claude 6, Claude 5):
 *
 *   A. handOverAgain read the paid record leniently: a GET answered in another shape read as "no paid record any
 *      more", and the order left the hand-over list with nothing handed over. Unknown keeps it there.
 *   B. the hand-over list was written only in the catch of a product read that failed, with a ZADD whose answer was
 *      not checked: a product read and that ZADD both failing (Redis slow for an instant), or the ZADD answering
 *      nothing, left a paid order in no list at all. The order now joins the list in the same pipeline that takes it
 *      off pending, before anything is handed over, and leaves it only once it is handed over; the sweep takes an
 *      order from the list only after the return's own hand-over has had its time.
 *
 * Synthetic only: a stand-in for PayPal's API, the Redis stub, the real return route and the real sweep (what it
 * hands over counted by its own `cleared`).
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
  if (cap && method === "GET") return json({ id: cap, status: "COMPLETED" });
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
  process.env.RESEND_API_KEY = "re_test_paypal_sales";
  delete process.env.PAYPAL_ENV;
  process.env.PAYPAL_PARTNER_CLIENT_ID = PARTNER_CLIENT;
  process.env.PAYPAL_PARTNER_SECRET = "EPpartnerSecret0123456789";
  process.env.PAYPAL_PARTNER_MERCHANT_ID = "PARTNERMERCH01";
  process.env.PAYPAL_BN_CODE = "NimbusLabs_SP";

  await claimHandle("owner@example.com", "harbor", "Harbor Kitchen", "");
  await ensureStatsId("owner@example.com");
  await setSubscription("owner@example.com", { customerId: "cus_Owner00001", subscriptionId: "sub_Owner00001", active: true, period: paidPeriod() });
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
  const queued = async () => (await redis.pipeline([["ZRANGEBYSCORE", handOverKey(statsId), "-inf", "+inf"]]))[0];
  /** A sweep an hour later than the last, as the cron runs. */
  const sweepLater = async () => {
    ahead += 3_600_000;
    swept += (await sweepPayPal(await fresh(), Date.now() + 10_000)).cleared;
  };
  const timeout = async () => {
    throw new Error("Synthetic: Redis timed out");
  };

  part("Healthy control: handed over once on the return, nothing left for the sweep");
  swept = 0;
  await buy(store, id, "healthy@example.com", () => null);
  is("handed over on the return", await owned("healthy@example.com"), 1);
  is("nothing left in the hand-over list", await queued(), []);
  await sweepLater();
  is("the sweep hands nothing over again", [await owned("healthy@example.com"), swept], [1, 0]);

  for (const [label, zadd] of [
    ["times out too", timeout],
    ["answers nothing", async () => []],
    ["answers in another shape", async () => [{ result: 1 }]],
  ] as [string, () => Promise<unknown[]>][]) {
    part(`Claude 5: the product read times out on the return, and the hand-over list's own ZADD ${label}`);
    swept = 0;
    const buyer = `slow-${label.replace(/\W+/g, "-")}@example.com`;
    const order = await buy(store, id, buyer, (c) =>
      single(c, "GET", listingKey) ? timeout() : single(c, "ZADD", handOverKey(statsId)) ? zadd() : null,
    );
    is("paid, written down, nothing handed over yet", [Boolean(await readPaid(order)), await owned(buyer)], [true, 0]);
    is("the order is in the hand-over list all the same", ((await queued()) as string[]).includes(order), true);
    await sweepLater();
    is("the next sweep hands it over, once", [await owned(buyer), swept], [1, 1]);
    await sweepLater();
    is("and never again", [await owned(buyer), swept, ((await queued()) as string[]).includes(order)], [1, 1, false]);
  }

  for (const [label, reply] of [
    ["wrapped in an object", (raw: unknown) => [{ result: raw }]],
    ["a number", () => [42]],
    ["no reply at all", () => []],
  ] as [string, (raw: unknown) => unknown[]][]) {
    part(`Claude 6: an order waiting in the hand-over list, its paid record read as ${label}: kept, then handed over once`);
    swept = 0;
    const buyer = `wait-${label.replace(/\W+/g, "-")}@example.com`;
    const order = await buy(store, id, buyer, (c) => (single(c, "GET", listingKey) ? timeout() : null));
    is("nothing handed over on the return", await owned(buyer), 0);
    const pipeline = redis.pipeline.bind(redis);
    redis.pipeline = (async (c: Commands) => {
      if (single(c, "GET", `nl:ppsell:paid:${order}`)) return reply((await pipeline(c))[0]);
      return pipeline(c);
    }) as typeof redis.pipeline;
    try {
      await sweepLater();
    } finally {
      redis.pipeline = pipeline;
    }
    is("that sweep keeps it in the list, nothing handed over", [((await queued()) as string[]).includes(order), await owned(buyer)], [true, 0]);
    await sweepLater();
    await sweepLater();
    is("two healthy sweeps hand it over once", [await owned(buyer), swept], [1, 1]);
  }

  part("Confirmed absence: an order in the list whose paid record Redis says is not there leaves it, nothing handed over");
  await redis.pipeline([["ZADD", handOverKey(statsId), "1", "5O190127TN3647188"]]);
  await sweepLater();
  is("it left the list", ((await queued()) as string[]).includes("5O190127TN3647188"), false);

  done();
}

main().catch((error) => {
  console.log(String(error?.stack ?? error));
  process.exit(1);
});
