/**
 * A PayPal sale's "sale.completed" webhook is never lost when telling the webhooks fails (issue #3937).
 *
 * emitEvent throws on purpose "so the caller tries again" when the event's once-only mark answers unknown or the
 * deliveries cannot be written (lib/webhooks.ts). Before: the PayPal hand-over swallowed that throw and took the order
 * off the hand-over list right after, and nothing else emits "sale.completed" for PayPal, so the creator's endpoint
 * never heard of the sale. Now the order stays on the list, as for a receipt still owed, and the sweep tells the
 * webhooks again inside the same bounded window (RECEIPT_RETRY_SECONDS), without sending the accepted receipt twice.
 *
 * Synthetic: PayPal and Resend stand-ins, the in-memory Redis (tests/redis-stub.ts), a local HTTP server behind
 * lib/safe-fetch.ts, the real return route, the real sweep (sweepPayPal) and the real webhook queue (deliverDue).
 */
import http from "node:http";
import https from "node:https";
import net from "node:net";
import { TEST_CONSENT } from "./digital-consent-fixture";
import { claimHandle, ensureStatsId, addProduct, setProductLink, setSubscription, setPayPalSeller, storeForEmail, type Store } from "@/lib/store";
import { type Listing, readListing } from "@/lib/catalog";
import { openOrder } from "@/lib/paypal-sales";
import * as delivery from "@/lib/paypal-delivery";
import { addEndpoint, deliverDue, setSendHooksForTests } from "@/lib/webhooks";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";
import { paidPeriod } from "./billing-period-fixture";
import { NextRequest } from "next/server";
import { GET as paypalReturn } from "@/app/api/store/paypal/return/route";

const PARTNER_CLIENT = "AZpartnerClientId0123456789";
const SELLER = "7KNGBPH2U58GQ";
const BUYER = "buyer@example.com";
const orders = new Map<string, Record<string, unknown>>();
let made = 0;
const orderId = (n: number) => `5O190127TN36472${String(n).padStart(2, "0")}`;
let mail: "up" | "422" = "up";
/** Every POST to the sender, accepted or not, by idempotency key. */
const tries: string[] = [];

/** What the creator's endpoint received, one parsed body a request. */
const received: { type: string; data: Record<string, unknown> }[] = [];
const server = http.createServer((request, response) => {
  let body = "";
  request.on("data", (chunk: Buffer) => (body += chunk.toString()));
  request.on("end", () => {
    try {
      received.push(JSON.parse(body));
    } catch {
      received.push({ type: "unreadable", data: {} });
    }
    response.writeHead(200);
    response.end("ok");
  });
});

class LocalAgent extends https.Agent {
  constructor(private port: number) {
    super({ keepAlive: false });
  }
  createConnection(): net.Socket {
    return net.connect(this.port, "127.0.0.1");
  }
}

function completed(order: string, value: string, email: string): Record<string, unknown> {
  return {
    id: order,
    status: "COMPLETED",
    payer: { email_address: email, payer_id: "QYR5Z8XDVJNXQ" },
    purchase_units: [{ reference_id: "x", payee: { merchant_id: SELLER }, payments: { captures: [{ id: `3C679366HH9088${order.slice(-2)}`, status: "COMPLETED", amount: { currency_code: "USD", value } }] } }],
  };
}

globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const url = new URL(String(input));
  const json = (v: unknown, status = 200) => new Response(JSON.stringify(v), { status });
  if (url.hostname === "api.resend.com") {
    if (url.pathname === "/emails") tries.push(new Headers(init?.headers).get("idempotency-key") ?? "");
    if (mail === "422") return json({ name: "validation_error", message: "synthetic refusal" }, 422);
    return json({ id: `e_${tries.length}` });
  }
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
    const body = completed(capture, "49.00", BUYER);
    orders.set(capture, body);
    return json(body, 201);
  }
  const read = /^\/v2\/checkout\/orders\/([A-Z0-9]+)$/.exec(url.pathname)?.[1];
  if (read && method === "GET") return orders.has(read) ? json(orders.get(read)) : json({ name: "RESOURCE_NOT_FOUND" }, 404);
  const cap = /^\/v2\/payments\/captures\/([A-Z0-9]+)$/.exec(url.pathname)?.[1];
  if (cap && method === "GET") return json({ id: cap, status: "COMPLETED" });
  return json({ name: "RESOURCE_NOT_FOUND" }, 404);
}) as typeof fetch;

type Cmd = (string | number)[];
const original = redis.pipeline.bind(redis);
const isMark = (cmd: Cmd) => cmd[0] === "SET" && String(cmd[1]).startsWith("nl:hooks:evt:") && cmd.includes("NX");
/** How many of the next pipelines holding an event's once-only mark throw, as a passing Upstash timeout would. */
let markThrows = 0;
redis.pipeline = (async (commands: Cmd[]) => {
  if (markThrows > 0 && commands.some(isMark)) {
    markThrows -= 1;
    throw new Error("synthetic: the event mark's SET NX timed out");
  }
  // The webhook queue's lease (LEASE_SCRIPT in lib/webhooks.ts), as Redis runs it (as in tests/r24-webhook-event-claim.test.ts).
  const [only] = commands;
  if (commands.length === 1 && only[0] === "EVAL" && String(only[1]).includes('redis.call("ZSCORE", KEYS[1], ARGV[1])')) {
    const [, , , key, member, now, until] = only.map(String);
    const [due] = await original([["ZSCORE", key, member]]);
    if (due === null || due === undefined || Number(due) > Number(now)) return [0];
    await original([["ZADD", key, Number(until), member]]);
    return [1];
  }
  return original(commands);
}) as typeof redis.pipeline;

const realNow = Date.now.bind(Date);
let ahead = 0;
Date.now = () => realNow() + ahead;
const handOverKey = (statsId: string) => `nl:ppsell:handover:${statsId}`;

async function main(): Promise<void> {
  redis.clear();
  console.error = () => {};
  process.env.RESEND_API_KEY = "re_test_paypal_sales";
  delete process.env.PAYPAL_ENV;
  process.env.PAYPAL_PARTNER_CLIENT_ID = PARTNER_CLIENT;
  process.env.PAYPAL_PARTNER_SECRET = "EPpartnerSecret0123456789";
  process.env.PAYPAL_PARTNER_MERCHANT_ID = "PARTNERMERCH01";
  process.env.PAYPAL_BN_CODE = "NimbusLabs_SP";
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as net.AddressInfo).port;
  setSendHooksForTests({ fetch: { resolve: async () => [{ address: "93.184.216.34", family: 4 }], agent: new LocalAgent(port) as never } });

  await claimHandle("owner@example.com", "harbor", "Harbor Kitchen", "");
  await ensureStatsId("owner@example.com");
  await setSubscription("owner@example.com", { customerId: "cus_Owner00001", subscriptionId: "sub_Owner00001", active: true, period: paidPeriod() });
  const added = await addProduct("owner@example.com", "Sourdough Guide", "", "49", null);
  if (!added.ok) throw new Error("no product");
  await setProductLink("owner@example.com", added.product.id, "https://example.com/guide");
  await setPayPalSeller("owner@example.com", SELLER);
  const store: Store = (await storeForEmail("owner@example.com"))!;
  const endpoint = await addEndpoint(store, "https://hooks.example.com/sales", ["sale.completed"]);
  if (!endpoint.ok) throw new Error("no endpoint");
  const statsId = store.statsId!;
  const product: Listing = (await readListing(store, added.product.id))!;
  const fresh = async () => (await storeForEmail("owner@example.com"))!;
  const listed = async () => (await original([["ZRANGEBYSCORE", handOverKey(statsId), "-inf", "+inf"]]))[0] as string[];
  /** Waits for the endpoint's requests in flight: until nothing new arrives for 300 ms, at most 5 seconds. */
  const settle = async () => {
    const until = realNow() + 5_000;
    let seen = -1;
    while (seen !== received.length && realNow() < until) {
      seen = received.length;
      await new Promise((resolve) => setTimeout(resolve, 300));
    }
  };
  const sweep = async (hours = 1): Promise<void> => {
    ahead += hours * 3_600_000;
    await delivery.sweepPayPal(await fresh(), Date.now() + 10_000);
    await deliverDue(Date.now() + 10_000);
    await settle();
  };
  const pay = async (n: number): Promise<string> => {
    const opened = await openOrder(store, product, "https://marktmorgen.com", { digitalConsent: TEST_CONSENT });
    if (!opened.ok) throw new Error(opened.reason);
    await paypalReturn(new NextRequest(`https://marktmorgen.com/api/store/paypal/return?store=harbor&token=${opened.order}`, { headers: { host: "marktmorgen.com", "x-forwarded-for": `198.51.100.${n}` } }));
    await settle();
    return opened.order;
  };
  const sales = (order: string) => received.filter((r) => r.type === "sale.completed" && r.data.paypal_order === order).length;
  const receiptTries = (order: string) => tries.filter((key) => key === `nimbus-paypal:${order}`).length;

  part("Healthy control: one sale.completed and one receipt, the order off the list at once");
  const first = await pay(1);
  is("the endpoint heard of the sale once", sales(first), 1);
  is("one receipt request", receiptTries(first), 1);
  is("the order is no longer owed a hand-over", (await listed()).includes(first), false);

  part("The event's once-only mark times out on the return: the sale is told at the next sweep, once");
  markThrows = 1;
  const second = await pay(2);
  is("control: the mark did time out", markThrows, 0);
  is("the endpoint heard nothing yet", sales(second), 0);
  is("the receipt went out once", receiptTries(second), 1);
  is("the order stays on the hand-over list, its event still owed", (await listed()).includes(second), true);
  await sweep();
  is("the next sweep tells the endpoint of the sale", sales(second), 1);
  is("then the order leaves the list", (await listed()).includes(second), false);
  is("the accepted receipt is not asked of the sender again", receiptTries(second), 1);
  await sweep();
  await sweep();
  is("never told twice", sales(second), 1);

  part("The receipt refused and the mark timing out together: both owed, both done once");
  mail = "422";
  markThrows = 1;
  const third = await pay(3);
  mail = "up";
  is("neither the event nor an accepted receipt yet", [sales(third), receiptTries(third)], [0, 1]);
  is("kept on the list", (await listed()).includes(third), true);
  await sweep();
  is("the sweep sends the receipt and tells the endpoint", [sales(third), receiptTries(third)], [1, 2]);
  is("then off the list", (await listed()).includes(third), false);

  part("Bounded: a mark that keeps timing out leaves the list past the window, never retried forever");
  markThrows = 1_000;
  const fourth = await pay(4);
  is("kept at first", (await listed()).includes(fourth), true);
  await sweep();
  is("still kept inside the window", (await listed()).includes(fourth), true);
  await sweep(delivery.RECEIPT_RETRY_SECONDS / 3600 + 1);
  is("past the window it leaves the list", (await listed()).includes(fourth), false);
  is("its accepted receipt was asked of the sender once", receiptTries(fourth), 1);
  markThrows = 0;

  server.close();
  done();
}

main().catch((error) => {
  console.log(String(error?.stack ?? error));
  server.close();
  process.exit(1);
});
