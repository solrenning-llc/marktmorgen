/**
 * Independent proof for PR #2895 at 8c93eedf4bb257da4e7d7ce50413aea7d7d06cfa.
 * Synthetic PayPal, Redis and mail only; no provider request leaves this process.
 */
import { strict as assert } from "node:assert";
import { test } from "node:test";
import { NextRequest } from "next/server";
import { paidPeriod } from "./billing-period-fixture";
import { TEST_CONSENT } from "./digital-consent-fixture";
import { store as redis } from "./redis-stub";
import {
  addProduct,
  claimHandle,
  ensureStatsId,
  removeProduct,
  setPayPalSeller,
  setProductLink,
  setSubscription,
  storeForEmail,
  type Store,
} from "@/lib/store";
import { readListing } from "@/lib/catalog";
import { importedFor } from "@/lib/imported-purchases";
import { openOrder, readPaid } from "@/lib/paypal-sales";
import { GET as paypalReturn } from "@/app/api/store/paypal/return/route";

const OWNER = "owner@example.com";
const BUYER = "buyer@example.com";
const SELLER = "7KNGBPH2U58GQ";
process.env.PAYPAL_PARTNER_CLIENT_ID = "AZpartnerClientId0123456789";
process.env.PAYPAL_PARTNER_SECRET = "EPpartnerSecret0123456789";
process.env.PAYPAL_PARTNER_MERCHANT_ID = "PARTNERMERCH01";
process.env.PAYPAL_BN_CODE = "Synthetic_SP";
process.env.RESEND_API_KEY = "re_test_z_2895_product_gone";
delete process.env.PAYPAL_ENV;
delete process.env.PAYPAL_API_BASE;

let made = 0;
let captures = 0;
let emails = 0;
const amounts = new Map<string, string>();
globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const url = new URL(String(input));
  const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
  if (url.hostname === "api.resend.com" && url.pathname === "/emails") {
    emails += 1;
    return json({ id: `synthetic-mail-${emails}` });
  }
  if (url.pathname === "/v1/oauth2/token") return json({ access_token: "synthetic-token", expires_in: 3600 });
  const method = init?.method ?? "GET";
  if (url.pathname === "/v2/checkout/orders" && method === "POST") {
    made += 1;
    const order = `5O1901ZGONE${String(made).padStart(5, "0")}`;
    const body = JSON.parse(String(init?.body)) as { purchase_units: { amount: { value: string } }[] };
    amounts.set(order, body.purchase_units[0].amount.value);
    return json({ id: order, status: "PAYER_ACTION_REQUIRED", links: [{ href: `https://www.paypal.com/checkoutnow?token=${order}`, rel: "payer-action" }] });
  }
  const match = url.pathname.match(/^\/v2\/checkout\/orders\/([A-Z0-9]+)(\/capture)?$/);
  if (!match) throw new Error(`unexpected synthetic request: ${method} ${url.pathname}`);
  const order = match[1];
  if (match[2]) captures += 1;
  return json({
    id: order,
    status: "COMPLETED",
    payer: { email_address: BUYER },
    purchase_units: [{
      payee: { merchant_id: SELLER },
      payments: { captures: [{ id: `CAP${order.slice(-8)}`, status: "COMPLETED", amount: { value: amounts.get(order), currency_code: "USD" } }] },
    }],
  });
}) as typeof fetch;

async function shop(): Promise<{ store: Store; productId: string; order: string }> {
  redis.clear();
  emails = 0;
  await claimHandle(OWNER, "harbor", "Harbor Kitchen", "");
  await ensureStatsId(OWNER);
  await setSubscription(OWNER, { customerId: "cus_Owner00001", subscriptionId: "sub_Owner00001", active: true, period: paidPeriod() });
  const added = await addProduct(OWNER, "Sourdough Guide", "", "49", null);
  if (!added.ok) throw new Error("product setup failed");
  await setProductLink(OWNER, added.product.id, "https://example.com/guide");
  await setPayPalSeller(OWNER, SELLER);
  const store = (await storeForEmail(OWNER))!;
  const product = (await readListing(store, added.product.id))!;
  const opened = await openOrder(store, product, "https://marktmorgen.com", { digitalConsent: TEST_CONSENT });
  if (!opened.ok) throw new Error(`order setup failed: ${opened.reason}`);
  return { store, productId: added.product.id, order: opened.order };
}

const pending = async (store: Store, order: string) =>
  (await redis.pipeline([["ZSCORE", `nl:ppsell:pending:${store.statsId}`, order]]))[0];
const returnOrder = (order: string) =>
  paypalReturn(new NextRequest(`https://marktmorgen.com/api/store/paypal/return?store=harbor&token=${order}`));
const grants = (store: Store) => importedFor({ ...store, pastBuyers: true }, BUYER);

test("finding: a removed product makes the return record the captured payment but remove pending with zero delivery", async () => {
  const { productId, order } = await shop();
  const removed = await removeProduct(OWNER, productId);
  assert.equal(removed.ok, true, "precondition: the creator removed the paid product");
  const current = (await storeForEmail(OWNER))!;
  assert.equal(await readListing(current, productId), null, "precondition: the paid product is gone from the current store");
  const capturesBefore = captures;
  const response = await returnOrder(order);
  const paid = await readPaid(order);
  assert.equal(response.status, 303);
  assert.match(response.headers.get("Location") ?? "", /\/thanks\?paypal=/);
  assert.equal(captures - capturesBefore, 1, "the provider capture happened exactly once");
  assert.equal(paid?.order, order, "the captured payment is recorded");
  assert.equal((await grants(current)).length, 0, "nothing was handed over");
  assert.equal(emails, 0, "no receipt was sent");
  assert.equal(await pending(current, order), null, "the undelivered paid order was removed from pending");
});

test("control: a present product records one capture, hands it over, and then removes pending", async () => {
  const { store, order } = await shop();
  const capturesBefore = captures;
  const response = await returnOrder(order);
  const paid = await readPaid(order);
  assert.equal(response.status, 303);
  assert.equal(captures - capturesBefore, 1);
  assert.equal(paid?.order, order);
  assert.equal((await grants(store)).length, 1, "the buyer received the present product");
  assert.equal(await pending(store, order), null, "settled only after delivery");
});
