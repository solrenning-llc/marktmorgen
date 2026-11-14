/**
 * An order opened before the creator disconnects PayPal, and approved by its buyer only after (review of #3924,
 * MEDIUM, Codex T, Claude 1 cloud and Claude 7): the disconnected account must not be forgotten while such an order
 * can still be paid. Before the fix the first sweep after the disconnection found the store's three PayPal lists
 * empty (the order is only on nl:ppsell:o: until its return), forgot the account and left the PayPal sweep, so a
 * payment PayPal held as pending at the return was never asked about again and never handed over.
 *
 * Synthetic only: a stand-in for PayPal's API, a stand-in for Resend and the Redis stub, through the real five-minute
 * job (lib/checkout-sweep.ts, sweepCheckouts) and the real disconnect (lib/store.ts, disconnectPayPalSeller).
 */
import { TEST_CONSENT } from "./digital-consent-fixture";
import { addProduct, claimHandle, disconnectPayPalSeller, ensureStatsId, setPayPalSeller, setProductLink, setSubscription, storeForEmail } from "@/lib/store";
import { readListing } from "@/lib/catalog";
import { captureOrder, openOrder, readPaid, stillPending } from "@/lib/paypal-sales";
import { sweepCheckouts } from "@/lib/checkout-sweep";
import { importedFor } from "@/lib/imported-purchases";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";
import { paidPeriod } from "./billing-period-fixture";

const SELLER = "7KNGBPH2U58GQ";
const orders = new Map<string, Record<string, unknown>>();
const captures = new Map<string, string>();
const failing = new Set<string>();
const emails: { to: string[]; subject: string; text: string; html?: string }[] = [];
let captureWith: (order: string) => Record<string, unknown> = () => ({});
let made = 0;
let paypalCalls = 0;
/** The PayPal-Auth-Assertion of every capture read (the refund watch's): whose account it was asked as. */
const captureReads: string[] = [];

const orderId = (n: number) => `9D190127TN36471${String(n).padStart(2, "0")}`;

function withCapture(order: string, status: string | undefined, email: string): Record<string, unknown> {
  const cap = `4C679366HH9087${order.slice(-2)}`;
  if (status) captures.set(cap, status);
  return {
    id: order,
    status: "COMPLETED",
    payer: { email_address: email },
    purchase_units: [{ payee: { merchant_id: SELLER }, payments: { captures: [{ id: cap, ...(status ? { status } : {}), amount: { currency_code: "USD", value: "49.00" } }] } }],
  };
}

globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const url = new URL(String(input));
  const json = (v: unknown, status = 200) => new Response(JSON.stringify(v), { status });
  if (url.hostname === "api.resend.com") {
    emails.push(JSON.parse(String(init?.body)));
    return json({ id: `e${emails.length}` });
  }
  if (url.hostname !== "api-m.paypal.com") return json({ error: "unexpected" }, 404);
  paypalCalls += 1;
  const method = init?.method ?? "GET";
  if (url.pathname === "/v1/oauth2/token") return json({ access_token: "A21AApartner", token_type: "Bearer", expires_in: 32400 });
  if (url.pathname === "/v2/checkout/orders" && method === "POST") {
    made += 1;
    const id = orderId(made);
    orders.set(id, { id, status: "PAYER_ACTION_REQUIRED" });
    return json({ id, status: "PAYER_ACTION_REQUIRED", links: [{ href: `https://www.paypal.com/checkoutnow?token=${id}`, rel: "payer-action" }] });
  }
  const capture = /^\/v2\/checkout\/orders\/([A-Z0-9]+)\/capture$/.exec(url.pathname)?.[1];
  if (capture && method === "POST") {
    const body = captureWith(capture);
    orders.set(capture, body);
    return json(body, 201);
  }
  const read = /^\/v2\/checkout\/orders\/([A-Z0-9]+)$/.exec(url.pathname)?.[1];
  if (read && method === "GET") {
    if (failing.has(read)) return json({ name: "INTERNAL_SERVER_ERROR" }, 500);
    return orders.has(read) ? json(orders.get(read)) : json({ name: "RESOURCE_NOT_FOUND" }, 404);
  }
  const cap = /^\/v2\/payments\/captures\/([A-Za-z0-9]+)$/.exec(url.pathname)?.[1];
  if (cap && method === "GET") {
    captureReads.push(new Headers(init?.headers).get("paypal-auth-assertion") ?? "");
    return json({ id: cap, status: captures.get(cap) ?? "COMPLETED" });
  }
  return json({ name: "RESOURCE_NOT_FOUND" }, 404);
}) as typeof fetch;

async function main(): Promise<void> {
  redis.clear();
  console.error = () => {};
  delete process.env.PAYPAL_ENV;
  process.env.RESEND_API_KEY = "re_test_paypal_sales";
  process.env.STRIPE_SECRET_KEY = "sk_test_synthetic_only";
  process.env.PAYPAL_PARTNER_CLIENT_ID = "AZpartnerClientId0123456789";
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
  let store = (await storeForEmail("owner@example.com"))!;
  const product = (await readListing(store, added.product.id))!;

  part("Opened before the disconnection, not yet approved: the account is kept");
  const opened = await openOrder(store, product, "https://marktmorgen.com", { digitalConsent: TEST_CONSENT });
  if (!opened.ok) throw new Error(`no order: ${opened.reason}`);
  const order = opened.order;
  await disconnectPayPalSeller("owner@example.com");
  store = (await storeForEmail("owner@example.com"))!;
  is("control: buyers can no longer start a PayPal payment", store.paypalSeller, null);
  await sweepCheckouts(Date.now() + 20_000);
  store = (await storeForEmail("owner@example.com"))!;
  is("the first sweep keeps the disconnected account while the order can still be paid", store.paypalPast?.merchant ?? null, SELLER);

  part("The buyer comes back, PayPal holds the payment as pending, then completes it: handed over");
  captureWith = (o) => withCapture(o, "PENDING", "late@example.com");
  const back = await captureOrder(store, order);
  is("control: the return finds it pending", back.ok ? "paid" : back.reason, "pending");
  is("control: now waited on", await stillPending(store, order), true);
  orders.set(order, withCapture(order, "COMPLETED", "late@example.com"));
  for (let run = 0; run < 3; run += 1) await sweepCheckouts(Date.now() + 20_000);
  store = (await storeForEmail("owner@example.com"))!;
  is("written down as paid", (await readPaid(order))?.email ?? null, "late@example.com");
  is("theirs on the store", (await importedFor(store, "late@example.com")).map((p) => p.job), [`paypal:${order}`]);
  is("no longer waited on", await stillPending(store, order), false);

  part("A paid record from before the account was kept with it, while disconnected: asked as the kept account");
  // Records written before paid.m existed fall back to the store's account; disconnected, that is the kept one, never
  // a crash on the missing connection (the merge of #3924 with main: store.paypalSeller is null here).
  const paidAt = `nl:ppsell:paid:${order}`;
  const [rawPaid] = await redis.pipeline([["GET", paidAt]]);
  const legacy = JSON.parse(String(rawPaid)) as Record<string, unknown>;
  delete legacy.m;
  await redis.pipeline([["SET", paidAt, JSON.stringify(legacy), "KEEPTTL"], ["ZADD", `nl:ppsell:watch:${store.statsId}`, "0", order]]);
  captureReads.length = 0;
  await sweepCheckouts(Date.now() + 20_000);
  is("its capture is read once", captureReads.length, 1);
  is("as the disconnected account", captureReads.map((a) => Buffer.from(a.split(".")[1] ?? "", "base64url").toString().includes(SELLER)), [true]);

  part("Nothing left and no order that can still be paid: the account is forgotten");
  // Past the time an order opened before the disconnection can still be approved (its record's three days).
  await redis.pipeline([["DEL", `nl:ppsell:watch:${store.statsId}`]]);
  const realNow = Date.now;
  Date.now = () => realNow() + 4 * 86_400_000;
  try {
    await sweepCheckouts(Date.now() + 20_000);
  } finally {
    Date.now = realNow;
  }
  store = (await storeForEmail("owner@example.com"))!;
  is("forgotten once nothing can come of it", store.paypalPast ?? null, null);
  is("emails sent along the way: the receipt only", emails.filter((e) => e.to.includes("late@example.com")).length, 1);
  is("PayPal was asked", paypalCalls > 0, true);
  done();
}

main().catch((error) => {
  console.log("✗ crashed:", error);
  process.exit(1);
});
