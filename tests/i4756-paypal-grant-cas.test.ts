/**
 * Issue #4756 (erasure, MEDIUM): the PayPal refund reconciler (lib/paypal-sales.ts)
 * replaced the earlier grant of a product bought twice with an unconditional
 * HSET, so a person's erasure that ran between its read and that write was
 * undone: the erased person's grant came back. Transcribed from Claude 2's
 * reproduction on main @8a47273d8e. The replacement is now made only while the
 * grant still holds the value read; an absent grant stays absent.
 */
import { TEST_CONSENT } from "./digital-consent-fixture";
import { claimHandle, ensureStatsId, addProduct, setProductLink, setSubscription, setPayPalSeller, storeForEmail, type Store } from "@/lib/store";
import { readListing } from "@/lib/catalog";
import { openOrder } from "@/lib/paypal-sales";
import { sweepPayPal } from "@/lib/paypal-delivery";
import { importedKey } from "@/lib/imported-purchases";
import { erasePerson } from "@/lib/person-erasure";
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
const override = new Map<string, Record<string, unknown>>();
const captureOf = (order: string) => `3C679366HH9087${order.slice(-2)}`;
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
  if (cap && method === "GET") {
    if (override.has(cap)) return json(override.get(cap));
    return json({ id: cap, status: refunded.has(cap) ? "REFUNDED" : "COMPLETED" });
  }
  return json({ name: "RESOURCE_NOT_FOUND" }, 404);
}) as typeof fetch;

const returnFor = (store: Store, order: string) =>
  paypalReturn(new NextRequest(`https://marktmorgen.com/api/store/paypal/return?store=${store.handle}&token=${order}`, { headers: { host: "marktmorgen.com", "x-forwarded-for": `198.51.100.${made}` } }));


const realNow = Date.now.bind(Date);
let ahead = 0;
Date.now = () => realNow() + ahead;
type Commands = (string | number)[][];

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
  const added = await addProduct("owner@example.com", "Sourdough Guide", "", "49", null);
  if (!added.ok) throw new Error("no product");
  await setProductLink("owner@example.com", added.product.id, "https://example.com/guide");
  await setPayPalSeller("owner@example.com", SELLER);
  const store = (await storeForEmail("owner@example.com"))!;
  const statsId = store.statsId!;
  const fresh = async () => (await storeForEmail("owner@example.com"))!;
  const buyer = "twice-buyer@example.com";
  const product = (await readListing(store, added.product.id))!;
  const orderIds: string[] = [];
  for (let i = 0; i < 2; i += 1) {
    const opened = await openOrder(store, product, "https://marktmorgen.com", { digitalConsent: TEST_CONSENT });
    if (!opened.ok) throw new Error("no order");
    buyerFor = buyer;
    await returnFor(store, opened.order);
    orderIds.push(opened.order);
  }
  part("the same product bought twice, the first order refunded in full while the person is erased");
  const grantKey = importedKey(statsId, buyer);
  const before = (await redis.pipeline([["HGET", grantKey, added.product.id]]))[0];
  console.log("grant before:", before);
  refunded.add(captureOf(orderIds[0]));
  const real = redis.pipeline.bind(redis);
  let erased = false;
  redis.pipeline = (async (commands: Commands) => {
    if (!erased && commands.length === 1 && ((commands[0][0] === "HSET" && commands[0][1] === grantKey) || (commands[0][0] === "EVAL" && String(commands[0][1]).startsWith("-- marktmorgen:hset-if-equal:") && commands[0][3] === grantKey))) {
      erased = true;
      redis.pipeline = real;
      const r = await erasePerson(await fresh(), buyer, { kind: "person" });
      if (!r.ok) throw new Error("erasure not ok");
    }
    return real(commands);
  }) as typeof redis.pipeline;
  for (let i = 0; i < 2; i += 1) { ahead += 3_600_000; await sweepPayPal(await fresh(), Date.now() + 10_000); }
  redis.pipeline = real;
  is("the erasure ran between the read and the grant write", erased, true);
  is("the erased person's grant stays absent", (await redis.pipeline([["HEXISTS", grantKey, added.product.id]]))[0], 0);
  done();
}
main().catch((error) => { console.log(String(error?.stack ?? error)); process.exit(1); });
