/**
 * The PayPal hand-over list's commands, as the cost registry states them (Claude 5's LEVE 2 on #2909): the list read
 * each sweep of a store makes, the orders one sweep tries (HAND_OVER_BATCH), the retry's own commands for each order
 * it tries (the paid record's GET, the refund mark's ZSCORE and at most two writes to the list), and the two
 * commands each PayPal sale adds to its own work (the list's ZADD when it is settled and its ZREM once handed over).
 * Each figure is read from what the real return route and the real sweep send, path by path, and must equal the
 * registry's (PAYPAL_HAND_OVER_RETRY and NOT_A_COST.HAND_OVER_BATCH in tests/plan-cost-registry.ts).
 *
 * Synthetic only: a stand-in for PayPal's API, the Redis stub, the real return route and the real sweep.
 */
import { TEST_CONSENT } from "./digital-consent-fixture";
import { claimHandle, ensureStatsId, addProduct, setProductLink, setSubscription, setPayPalSeller, storeForEmail, type Store } from "@/lib/store";
import { readListing, STORE_PAGE_SIZE } from "@/lib/catalog";
import { openOrder } from "@/lib/paypal-sales";
import { HAND_OVER_BATCH, sweepPayPal } from "@/lib/paypal-delivery";
import { NOT_A_COST, PAYPAL_HAND_OVER_RETRY } from "./plan-cost-registry";
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
let buyerFor = "a@example.com";

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
    const body = {
      id: capture,
      status: "COMPLETED",
      payer: { email_address: buyerFor, payer_id: "QYR5Z8XDVJNXQ" },
      purchase_units: [{ reference_id: "x", payee: { merchant_id: SELLER }, payments: { captures: [{ id: `3C679366HH9088${capture.slice(-2)}`, status: "COMPLETED", amount: { currency_code: "USD", value: "49.00" } }] } }],
    };
    orders.set(capture, body);
    return json(body, 201);
  }
  const read = /^\/v2\/checkout\/orders\/([A-Z0-9]+)$/.exec(url.pathname)?.[1];
  if (read && method === "GET") return orders.has(read) ? json(orders.get(read)) : json({ name: "RESOURCE_NOT_FOUND" }, 404);
  const cap = /^\/v2\/payments\/captures\/([A-Z0-9]+)$/.exec(url.pathname)?.[1];
  if (cap && method === "GET") return json({ id: cap, status: "COMPLETED" });
  return json({ name: "RESOURCE_NOT_FOUND" }, 404);
}) as typeof fetch;

const realNow = Date.now.bind(Date);
let ahead = 0;
Date.now = () => realNow() + ahead;
const handOverKey = (statsId: string) => `nl:ppsell:handover:${statsId}`;
const refundedKey = (statsId: string) => `nl:ppsell:refunded:${statsId}`;
const paidKey = (order: string) => `nl:ppsell:paid:${order}`;
type Commands = (string | number)[][];
type Fault = (c: Commands) => Promise<unknown[]> | null;
const single = (c: Commands, op: string, key: string) => c.length === 1 && c[0][0] === op && c[0][1] === key;
const timeout = async (): Promise<unknown[]> => {
  throw new Error("Synthetic: Redis timed out");
};

/** Every command sent while `run` runs, with `fault` answering in Redis's place where it returns a reply. */
async function recorded(run: () => Promise<unknown>, fault: Fault = () => null): Promise<Commands> {
  const sent: Commands = [];
  const pipeline = redis.pipeline.bind(redis);
  redis.pipeline = (async (commands: Commands) => {
    sent.push(...commands);
    return fault(commands) ?? pipeline(commands);
  }) as typeof redis.pipeline;
  try {
    await run();
  } finally {
    redis.pipeline = pipeline;
  }
  return sent;
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

  const declared: Partial<Record<keyof typeof PAYPAL_HAND_OVER_RETRY, number>> | undefined = PAYPAL_HAND_OVER_RETRY;
  const batch: unknown = HAND_OVER_BATCH;

  await claimHandle("owner@example.com", "harbor", "Harbor Kitchen", "");
  await ensureStatsId("owner@example.com");
  await setSubscription("owner@example.com", { customerId: "cus_Owner00001", subscriptionId: "sub_Owner00001", active: true, period: paidPeriod() });
  // More products than one page, so the product is read by its own listing key (the one the faults below time out).
  for (let i = 0; i < STORE_PAGE_SIZE + 1; i += 1) {
    const more = await addProduct("owner@example.com", `Recipe ${i}`, "", "9", null);
    if (!more.ok) throw new Error(`no product ${i}: ${JSON.stringify(more)}`);
  }
  const added = await addProduct("owner@example.com", "Sourdough Guide", "", "49", null);
  if (!added.ok) throw new Error("no product");
  await setProductLink("owner@example.com", added.product.id, "https://example.com/guide");
  await setPayPalSeller("owner@example.com", SELLER);
  const fresh = async () => (await storeForEmail("owner@example.com"))!;
  const store = await fresh();
  const statsId = store.statsId!;
  const id = added.product.id;
  const listingKey = `nl:catalog:${store.catalog.id}:l:${id}`;
  const slowListing: Fault = (c) => (single(c, "GET", listingKey) ? timeout() : null);

  const returnFor = (s: Store, order: string) =>
    paypalReturn(new NextRequest(`https://marktmorgen.com/api/store/paypal/return?store=${s.handle}&token=${order}`, { headers: { host: "marktmorgen.com", "x-forwarded-for": `198.51.100.${made}` } }));
  /** One PayPal purchase through the real return route; the commands it sent. */
  const buy = async (buyer: string, fault: Fault = () => null): Promise<{ order: string; sent: Commands }> => {
    const product = (await readListing(store, id))!;
    const opened = await openOrder(store, product, "https://marktmorgen.com", { digitalConsent: TEST_CONSENT });
    if (!opened.ok) throw new Error(`no order: ${opened.reason}`);
    buyerFor = buyer;
    const sent = await recorded(() => returnFor(store, opened.order), fault);
    return { order: opened.order, sent };
  };
  /** One sweep of the store, past every order's grace; what the hand-over retry sent (from its list read on). */
  const retry = async (fault: Fault = () => null): Promise<Commands> => {
    ahead += 3_600_000;
    const s = await fresh();
    const sent = await recorded(() => sweepPayPal(s, Date.now() + 10_000), fault);
    const from = sent.findIndex((c) => c[0] === "ZRANGEBYSCORE" && c[1] === handOverKey(statsId));
    return from < 0 ? [] : sent.slice(from);
  };
  /** The retry's own commands for one order: the paid record's GET, the refund mark's ZSCORE and the list's writes. */
  const own = (sent: Commands, order: string) =>
    sent.filter((c) => (c[1] === handOverKey(statsId) && c[0] !== "ZRANGEBYSCORE" && c[c.length - 1] === order)
      || (c[0] === "GET" && c[1] === paidKey(order))
      || (c[0] === "ZSCORE" && c[1] === refundedKey(statsId) && c[2] === order)).map((c) => String(c[0]));
  const queued = async () => (await redis.pipeline([["ZRANGEBYSCORE", handOverKey(statsId), "-inf", "+inf"]]))[0] as string[];

  part("The registry states the hand-over list's commands");
  is("PAYPAL_HAND_OVER_RETRY is in tests/plan-cost-registry.ts", typeof declared, "object");
  is("NOT_A_COST says why the batch is bounded, naming handOverAgain", typeof NOT_A_COST.HAND_OVER_BATCH === "string" && NOT_A_COST.HAND_OVER_BATCH.includes("handOverAgain"), true);
  is("lib/paypal-delivery.ts exports the batch the registry cites", typeof batch, "number");

  part("Each PayPal sale: the list's ZADD when settled and its ZREM once handed over");
  const healthy = await buy("healthy@example.com");
  const saleList = healthy.sent.filter((c) => c[1] === handOverKey(statsId)).map((c) => String(c[0]));
  is("a healthy return sends two commands to the list", saleList, ["ZADD", "ZREM"]);
  is("as the registry states", saleList.length, declared?.listCommandsPerSale);

  part("One sweep with nothing due: one read of the list");
  const idle = await retry();
  is("the list read and nothing else", idle.map((c) => `${c[0]} ${c[1]}`), [`ZRANGEBYSCORE ${handOverKey(statsId)}`]);
  is("as the registry states", idle.length, declared?.listReadsPerStoreRun);

  part("The retry's own commands for each order it tries, path by path");
  const counted: Record<string, string[]> = {};
  // Its paid record gone (erased, or past its time): GET, then ZREM.
  const goneOrder = "HANDOVERGONE01";
  await redis.pipeline([["ZADD", handOverKey(statsId), "1", goneOrder]]);
  counted.gone = own(await retry(), goneOrder);
  is("paid record gone: GET and ZREM", counted.gone, ["GET", "ZREM"]);
  // Refunded in full meanwhile: GET, ZSCORE, then ZREM.
  const refunded = await buy("refunded@example.com", slowListing);
  await redis.pipeline([["ZADD", refundedKey(statsId), String(Math.floor(Date.now() / 1000)), refunded.order]]);
  counted.refunded = own(await retry(), refunded.order);
  is("refunded: GET, ZSCORE and ZREM", counted.refunded, ["GET", "ZSCORE", "ZREM"]);
  // The refund mark in another shape: GET, ZSCORE, then the ZADD that keeps it.
  const unknownMark = await buy("unknown-mark@example.com", slowListing);
  counted.unknownMark = own(await retry((c) => (single(c, "ZSCORE", refundedKey(statsId)) ? Promise.resolve(["abc"]) : null)), unknownMark.order);
  is("refund mark unknown: GET, ZSCORE and ZADD", counted.unknownMark, ["GET", "ZSCORE", "ZADD"]);
  // The product still unreadable: GET, ZSCORE, then the hand-over's ZADD and the retry's ZADD.
  const slow = await buy("slow@example.com", slowListing);
  counted.unreadable = own(await retry(slowListing), slow.order);
  is("product unreadable: GET, ZSCORE and two ZADDs", counted.unreadable, ["GET", "ZSCORE", "ZADD", "ZADD"]);
  // Handed over: GET, ZSCORE, then the hand-over's ZREM (its other work is the order's own).
  counted.handed = own(await retry(), slow.order);
  is("handed over: GET, ZSCORE and ZREM", counted.handed, ["GET", "ZSCORE", "ZREM"]);
  is("and it left the list", (await queued()).includes(slow.order), false);
  const most = Math.max(...Object.values(counted).map((c) => c.length));
  is("the most on any path is four", most, 4);
  is("as the registry states", most, declared?.ownCommandsPerOrderTried);

  part("One sweep tries at most HAND_OVER_BATCH orders");
  await redis.pipeline([["DEL", handOverKey(statsId)]]);
  const many = Array.from({ length: 30 }, (_, n) => `HANDOVERMANY${String(n).padStart(2, "0")}`);
  await redis.pipeline([["ZADD", handOverKey(statsId), ...many.flatMap((order, n) => [String(n + 1), order])]]);
  const full = await retry();
  const tried = many.filter((order) => full.some((c) => c[0] === "GET" && c[1] === paidKey(order))).length;
  is("the list read asks for the batch", full[0]?.slice(-1)[0], batch);
  is("orders tried in one sweep", tried, batch);
  is("as the registry states", tried, declared?.ordersPerStoreRun);
  is("the rest wait for the next sweep", (await queued()).length, 30 - Number(batch));

  done();
}

main().catch((error) => {
  console.log(String(error?.stack ?? error));
  process.exit(1);
});
