/**
 * RED (C7 bug hunt, 12 November 2026): the PayPal sweep forgets the orders a store already took through PayPal as
 * soon as the store's connected PayPal account changes.
 *
 *   1. The creator disconnects PayPal (app/api/store/paypal/disconnect, "What was already bought stays bought").
 *      watchPayPal returns at once when store.paypalSeller is null (and lib/checkout-sweep.ts only calls sweepPayPal
 *      while it is set), so:
 *        - a payment PayPal held as pending that completes afterwards is never handed over: the buyer paid and gets
 *          nothing (the pending loop itself only needs the order's own merchant, kept on the opened order);
 *        - a full refund the creator makes afterwards in their PayPal is never seen: the buyer keeps the purchase and
 *          the refund never reaches the refund mark that the affiliate book (readPayPalRefundsWithCoverage) reads, so
 *          the commission on the refunded sale stays owed.
 *   2. The creator connects ANOTHER PayPal account. The refund watch reads every old capture under the NEW account's
 *      PayPal-Auth-Assertion (store.paypalSeller.merchant), not the account the order was paid to (the paid record
 *      does not keep it). PayPal does not show one merchant's capture to another, so a refund is never seen.
 *
 * Synthetic data only; PayPal is a stand-in that shows a capture only to the merchant it was paid to.
 */
import { TEST_CONSENT } from "./digital-consent-fixture";
import { claimHandle, ensureStatsId, addProduct, setProductLink, setSubscription, setPayPalSeller, storeForEmail } from "@/lib/store";
import { readListing } from "@/lib/catalog";
import { captureOrder, openOrder, watchPayPal } from "@/lib/paypal-sales";
import { handOverPayPal } from "@/lib/paypal-delivery";
import { importedFor } from "@/lib/imported-purchases";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";
import { paidPeriod } from "./billing-period-fixture";

const PARTNER_CLIENT = "AZpartnerClientId0123456789";
const PARTNER_SECRET = "EPpartnerSecret0123456789";
const PARTNER = "PARTNERMERCH01";
const SELLER = "7KNGBPH2U58GQ";
const OTHER_SELLER = "9ZZZBPH2U58QQ";

const orders = new Map<string, Record<string, unknown>>();
/** capture id -> its status and the merchant it was paid to */
const captures = new Map<string, { status: string; merchant: string }>();
let made = 0;
let captureWith: (order: string) => { status: number; body: Record<string, unknown> } = () => ({ status: 500, body: {} });
const orderId = (n: number) => `7P190127TN36471${String(n).padStart(2, "0")}`;

function body(order: string, status: string, email: string): Record<string, unknown> {
  const cap = `4D679366HH9087${order.slice(-2)}`;
  captures.set(cap, { status, merchant: SELLER });
  return {
    id: order,
    status: "COMPLETED",
    payer: { email_address: email },
    purchase_units: [{ payee: { merchant_id: SELLER }, payments: { captures: [{ id: cap, status, amount: { currency_code: "USD", value: "49.00" } }] } }],
  };
}

const assertedMerchant = (headers: Headers): string => {
  const claims = String(headers.get("paypal-auth-assertion") ?? "").split(".")[1] ?? "";
  try {
    return String((JSON.parse(Buffer.from(claims, "base64url").toString()) as { payer_id?: unknown }).payer_id ?? "");
  } catch {
    return "";
  }
};

globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const url = new URL(String(input));
  const json = (v: unknown, status = 200) => new Response(JSON.stringify(v), { status });
  if (url.hostname === "api.resend.com") return json({ id: "e" });
  if (url.hostname !== "api-m.paypal.com") return json({ error: "unexpected" }, 404);
  const headers = new Headers(init?.headers);
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
    const answer = captureWith(capture);
    if (answer.status < 300) orders.set(capture, answer.body);
    return json(answer.body, answer.status);
  }
  const read = /^\/v2\/checkout\/orders\/([A-Z0-9]+)$/.exec(url.pathname)?.[1];
  if (read && method === "GET") {
    if (assertedMerchant(headers) !== SELLER) return json({ name: "RESOURCE_NOT_FOUND" }, 404);
    return orders.has(read) ? json(orders.get(read)) : json({ name: "RESOURCE_NOT_FOUND" }, 404);
  }
  const cap = /^\/v2\/payments\/captures\/([A-Z0-9]+)$/.exec(url.pathname)?.[1];
  if (cap && method === "GET") {
    const held = captures.get(cap);
    // A capture is shown only to the account it was paid to.
    if (!held || assertedMerchant(headers) !== held.merchant) return json({ name: "RESOURCE_NOT_FOUND" }, 404);
    return json({ id: cap, status: held.status });
  }
  return json({ name: "RESOURCE_NOT_FOUND" }, 404);
}) as typeof fetch;

async function main(): Promise<void> {
  redis.clear();
  process.env.RESEND_API_KEY = "re_test_c7_paypal_sw";
  delete process.env.PAYPAL_ENV;
  process.env.PAYPAL_PARTNER_CLIENT_ID = PARTNER_CLIENT;
  process.env.PAYPAL_PARTNER_SECRET = PARTNER_SECRET;
  process.env.PAYPAL_PARTNER_MERCHANT_ID = PARTNER;
  process.env.PAYPAL_BN_CODE = "NimbusLabs_SP";

  await claimHandle("owner@example.com", "harbor", "Harbor Kitchen", "");
  await ensureStatsId("owner@example.com");
  await setSubscription("owner@example.com", { customerId: "cus_Owner00001", subscriptionId: "sub_Owner00001", active: true, period: paidPeriod() });
  const added = await addProduct("owner@example.com", "Sourdough Guide", "", "49", null);
  if (!added.ok) throw new Error("no product");
  await setProductLink("owner@example.com", added.product.id, "https://example.com/guide");
  await setPayPalSeller("owner@example.com", SELLER);
  let store = (await storeForEmail("owner@example.com"))!;
  void store;

  part("The creator connects ANOTHER PayPal account; the first account's sale is refunded");
  redis.clear();
  orders.clear();
  captures.clear();
  await claimHandle("owner2@example.com", "harbor2", "Harbor Two", "");
  await ensureStatsId("owner2@example.com");
  await setSubscription("owner2@example.com", { customerId: "cus_Owner00002", subscriptionId: "sub_Owner00002", active: true, period: paidPeriod() });
  const added2 = await addProduct("owner2@example.com", "Rye Guide", "", "49", null);
  if (!added2.ok) throw new Error("no product");
  await setProductLink("owner2@example.com", added2.product.id, "https://example.com/rye");
  await setPayPalSeller("owner2@example.com", SELLER);
  store = (await storeForEmail("owner2@example.com"))!;
  const product2 = (await readListing(store, added2.product.id))!;
  const sold = await openOrder(store, product2, "https://marktmorgen.com", { digitalConsent: TEST_CONSENT });
  if (!sold.ok) throw new Error("no order");
  captureWith = (o) => ({ status: 201, body: body(o, "COMPLETED", "rye@example.com") });
  const ryePaid = await captureOrder(store, sold.order);
  if (!ryePaid.ok) throw new Error("not paid");
  await handOverPayPal(store, ryePaid.paid);
  is("the rye buyer holds the guide", (await importedFor((await storeForEmail("owner2@example.com"))!, "rye@example.com")).length, 1);
  await setPayPalSeller("owner2@example.com", OTHER_SELLER);
  store = (await storeForEmail("owner2@example.com"))!;
  captures.set(ryePaid.paid.capture, { status: "REFUNDED", merchant: SELLER });
  await redis.pipeline([["ZADD", `nl:ppsell:watch:${store.statsId}`, "0", sold.order]]);
  const after = await watchPayPal(store, Date.now() + 10_000, { handOver: async () => undefined, dropStart: async () => undefined });
  is("the refund on the account the sale was paid to is seen, and the purchase taken back", [after.revoked, (await importedFor(store, "rye@example.com")).length], [1, 0]);

  done();
}

void main();
