/**
 * PayPal selling, with answers that are not in PayPal's exact shape (CX-123
 * rule 24, Claude 5, 05/11/2026). A buyer's money may already be taken when
 * the answer to the capture is unreadable or lacks the buyer's address; an
 * order PayPal holds as pending may be read back garbled; a capture inside
 * the refund window may be read back garbled. None of these is "declined",
 * "failed" or "not refunded": each stays for the sweep to ask again, so a
 * buyer who paid is handed what they bought and a refund is never missed.
 * Synthetic only: a stand-in for PayPal's API on api-m.paypal.com.
 */
import { TEST_CONSENT } from "./digital-consent-fixture";
import { claimHandle, ensureStatsId, addProduct, setProductLink, setSubscription, setPayPalSeller, storeForEmail } from "@/lib/store";
import { readListing } from "@/lib/catalog";
import { captureOrder, openOrder, readPaid, stillPending, watchPayPal } from "@/lib/paypal-sales";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";
import { paidPeriod } from "./billing-period-fixture";

const PARTNER_CLIENT = "AZpartnerClientId0123456789";
const PARTNER_SECRET = "EPpartnerSecret0123456789";
const PARTNER = "PARTNERMERCH01";
const SELLER = "7KNGBPH2U58GQ";
/** lib/paypal-sales.ts WATCH_SECONDS: how long a paid order is watched for a refund. */
const WATCH_SECONDS = 180 * 86_400;
const orders = new Map<string, Record<string, unknown>>();
/** How the stand-in answers: the order's capture, a read of the order, a read of a capture. */
let captureAnswer: (order: string) => Response = () => new Response("{}", { status: 500 });
let orderRead: "real" | "garbled" = "real";
let captureRead: "real" | "garbled" = "real";
const captureStatus = new Map<string, string>();
let made = 0;
const orderId = (n: number) => `7P190127TN36471${String(n).padStart(2, "0")}`;

function completed(order: string, value: string, email: string | null = "Buyer@Example.com"): Record<string, unknown> {
  const cap = `9C679366HH9087${order.slice(-2)}`;
  captureStatus.set(cap, "COMPLETED");
  return {
    id: order,
    status: "COMPLETED",
    payer: email === null ? { payer_id: "QYR5Z8XDVJNXQ" } : { email_address: email, payer_id: "QYR5Z8XDVJNXQ" },
    purchase_units: [{ reference_id: "x", payee: { merchant_id: SELLER }, payments: { captures: [{ id: cap, status: "COMPLETED", amount: { currency_code: "USD", value } }] } }],
  };
}

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
  if (capture && method === "POST") return captureAnswer(capture);
  const read = /^\/v2\/checkout\/orders\/([A-Z0-9]+)$/.exec(url.pathname)?.[1];
  if (read && method === "GET") {
    if (orderRead === "garbled") return new Response("<html>gateway</html>", { status: 200 });
    return orders.has(read) ? json(orders.get(read)) : json({ name: "RESOURCE_NOT_FOUND" }, 404);
  }
  const cap = /^\/v2\/payments\/captures\/([A-Z0-9]+)$/.exec(url.pathname)?.[1];
  if (cap && method === "GET") {
    if (captureRead === "garbled") return new Response("", { status: 200 });
    return json({ id: cap, status: captureStatus.get(cap) ?? "COMPLETED" });
  }
  return json({ name: "RESOURCE_NOT_FOUND" }, 404);
}) as typeof fetch;

async function main(): Promise<void> {
  redis.clear();
  console.error = () => {};
  process.env.RESEND_API_KEY = "re_test_paypal_shape";
  delete process.env.PAYPAL_ENV;
  process.env.PAYPAL_PARTNER_CLIENT_ID = PARTNER_CLIENT;
  process.env.PAYPAL_PARTNER_SECRET = PARTNER_SECRET;
  process.env.PAYPAL_PARTNER_MERCHANT_ID = PARTNER;
  process.env.PAYPAL_BN_CODE = "NimbusLabs_SP";
  await claimHandle("shape@example.com", "shapes", "Shape Kitchen", "");
  await ensureStatsId("shape@example.com");
  await setSubscription("shape@example.com", { customerId: "cus_Shape00001", subscriptionId: "sub_Shape00001", active: true, period: paidPeriod() });
  const added = await addProduct("shape@example.com", "Sourdough Guide", "", "49", null);
  if (!added.ok) throw new Error("no product");
  await setProductLink("shape@example.com", added.product.id, "https://example.com/guide");
  await setPayPalSeller("shape@example.com", SELLER);
  const store = (await storeForEmail("shape@example.com"))!;
  const product = (await readListing(store, added.product.id))!;
  const handed: string[] = [];
  const on = { handOver: async (paid: { order: string }) => { handed.push(paid.order); }, dropStart: async () => {} };
  const open = async () => {
    const o = await openOrder(store, product, "https://marktmorgen.com", { digitalConsent: TEST_CONSENT });
    if (!o.ok) throw new Error(`no order: ${o.reason}`);
    return o.order;
  };

  part("Captured, the answer unreadable: kept for the sweep, handed over once PayPal is read");
  {
    const order = await open();
    captureAnswer = (o) => {
      orders.set(o, completed(o, "49.00"));
      return new Response("<html>upstream</html>", { status: 201 });
    };
    orderRead = "garbled";
    const first = await captureOrder(store, order);
    is("not reported as paid yet", first.ok, false);
    is("the order is kept for the sweep", await stillPending(store, order), true);
    orderRead = "real";
    await watchPayPal(store, Date.now() + 30_000, on);
    is("the sweep hands it over, once", [handed.filter((h) => h === order).length, Boolean(await readPaid(order))], [1, true]);
  }

  part("Captured, the answer without the buyer's address: kept for the sweep");
  {
    const order = await open();
    captureAnswer = (o) => {
      orders.set(o, completed(o, "49.00"));
      return new Response(JSON.stringify(completed(o, "49.00", null)), { status: 201 });
    };
    const first = await captureOrder(store, order);
    is("not reported as paid yet", first.ok, false);
    is("the order is kept for the sweep", await stillPending(store, order), true);
    await watchPayPal(store, Date.now() + 30_000, on);
    is("the sweep hands it over, once", handed.filter((h) => h === order).length, 1);
  }

  part("A pending order read back garbled stays watched");
  {
    const order = await open();
    captureAnswer = (o) => {
      const body = completed(o, "49.00");
      ((body.purchase_units as { payments: { captures: { status: string }[] } }[])[0].payments.captures[0]).status = "PENDING";
      orders.set(o, body);
      return new Response(JSON.stringify(body), { status: 201 });
    };
    const first = await captureOrder(store, order);
    is("pending", first.ok ? "paid" : first.reason, "pending");
    orderRead = "garbled";
    await watchPayPal(store, Date.now() + 30_000, on);
    is("still watched after a garbled read", await stillPending(store, order), true);
    orderRead = "real";
    orders.set(order, completed(order, "49.00"));
    // Its turn made to come now (assertion unchanged): since the pending backoff (Claude 2's MEDIUM on #3404) the sweep
    // asks a kept order again only at its next look (nextPendingLook).
    redis.run(["ZADD", `nl:ppsell:pending:${store.statsId}`, "1", order]);
    await watchPayPal(store, Date.now() + 30_000, on);
    is("handed over once PayPal completes it", handed.filter((h) => h === order).length, 1);
  }

  part("A paid order read back COMPLETED without its captures stays watched (review of Codex G on #2681)");
  {
    const order = await open();
    captureAnswer = (o) => {
      orders.set(o, completed(o, "49.00"));
      return new Response("<html>lost</html>", { status: 201 });
    };
    orders.set(order, { id: order, status: "PAYER_ACTION_REQUIRED" });
    orderRead = "garbled";
    await captureOrder(store, order);
    orderRead = "real";
    orders.set(order, { id: order, status: "COMPLETED" });
    await watchPayPal(store, Date.now() + 30_000, on);
    is("still watched", await stillPending(store, order), true);
    orders.set(order, completed(order, "49.00"));
    // Its turn made to come now (assertion unchanged): since the pending backoff (Claude 2's MEDIUM on #3404) the sweep
    // asks a kept order again only at its next look (nextPendingLook).
    redis.run(["ZADD", `nl:ppsell:pending:${store.statsId}`, "1", order]);
    await watchPayPal(store, Date.now() + 30_000, on);
    is("handed over once PayPal shows the capture", handed.filter((h) => h === order).length, 1);
  }

  part("A capture read back garbled at the end of its refund window is not taken for 'not refunded'");
  {
    const order = await open();
    captureAnswer = (o) => {
      orders.set(o, completed(o, "49.00"));
      return new Response(JSON.stringify(completed(o, "49.00")), { status: 201 });
    };
    const paid = await captureOrder(store, order);
    if (!paid.ok) throw new Error(`not paid: ${paid.reason}`);
    // Its window has just run out: the last look decides.
    const [raw] = await redis.pipeline([["GET", `nl:ppsell:paid:${order}`]]);
    const kept = JSON.parse(String(raw)) as { at: number };
    kept.at = Math.floor(Date.now() / 1000) - WATCH_SECONDS - 60;
    await redis.pipeline([["SET", `nl:ppsell:paid:${order}`, JSON.stringify(kept)], ["ZADD", `nl:ppsell:watch:${store.statsId}`, "0", order]]);
    captureRead = "garbled";
    await watchPayPal(store, Date.now() + 30_000, on);
    const [score] = await redis.pipeline([["ZSCORE", `nl:ppsell:watch:${store.statsId}`, order]]);
    is("still watched, to be asked again", score !== null, true);
    captureRead = "real";
  }
  done();
}

void main();
