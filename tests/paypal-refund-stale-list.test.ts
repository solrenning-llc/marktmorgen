/**
 * #4757: a PayPal refund reconciled by a sweep that started from a store snapshot with no list, after the person's own
 * erasure created the list and its mark, never names the erased buyer in refund.issued. Synthetic data, in-memory Redis.
 * Test from the issue (Codex L, reproduced by Claude 2).
 */
import { TEST_CONSENT } from "./digital-consent-fixture";
import { claimHandle, ensureStatsId, addProduct, setProductLink, setSubscription, setPayPalSeller, storeForEmail, type Store } from "@/lib/store";
import { readListing } from "@/lib/catalog";
import { openOrder } from "@/lib/paypal-sales";
import { sweepPayPal } from "@/lib/paypal-delivery";
import { erasePerson } from "@/lib/person-erasure";
import { addEndpoint } from "@/lib/webhooks";
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
  const fresh = async () => (await storeForEmail("owner@example.com"))!;
  // The sweep started from a snapshot of an old store that had no list; the list is made later (by an erasure) and is in the record by now.
  const staleStore = { ...(await fresh()), listId: null };
  is("the sweep's snapshot has no list yet", staleStore.listId ?? null, null);
  const statsId = staleStore.statsId!;
  const product = (await readListing(staleStore, added.product.id))!;
  const pay = async (buyer: string) => {
    const opened = await openOrder(staleStore, product, "https://marktmorgen.com", { digitalConsent: TEST_CONSENT });
    if (!opened.ok) throw new Error("no order");
    buyerFor = buyer;
    await returnFor(await fresh(), opened.order);
    return opened.order;
  };
  const erasedBuyer = "erased-buyer@example.com", controlBuyer = "control-buyer@example.com";
  const o1 = await pay(erasedBuyer), o2 = await pay(controlBuyer);
  const hooked = await addEndpoint(await fresh(), "https://hooks.example.com/marktmorgen", ["refund.issued"]);
  is("control: the store listens for refunds", hooked.ok, true);
  part("a snapshot taken before the store had a list, a refund reconciled after the person's own erasure");
  is("the person's own erasure completes", (await erasePerson(await fresh(), erasedBuyer, { kind: "person" })).ok, true);
  is("the store has a list now", Boolean((await fresh()).listId), true);
  for (const o of [o1, o2]) { refunded.add(captureOf(o)); redis.run(["ZADD", `nl:ppsell:watch:${statsId}`, "0", o]); }
  await sweepPayPal(staleStore, Date.now() + 10_000);
  const [log] = await redis.pipeline([["LRANGE", `nl:hooks:log:${statsId}`, 0, -1]]);
  const all = await Promise.all((log as string[]).map(async (id) => JSON.parse(String((await redis.pipeline([["GET", `nl:hooks:d:${id}`]]))[0])) as { type: string; body: string }));
  const refunds = all.filter((d) => d.type === "refund.issued").map((d) => JSON.parse(d.body).data as { paypal_capture: string; buyer: { email: string | null } });
  const of = (o: string) => refunds.find((r) => r.paypal_capture === captureOf(o))?.buyer;
  is("control: a buyer not deleted is named", of(o2)?.email, controlBuyer);
  is("the erased buyer's refund is told without their address", of(o1), { email: null, name: null });
  done();
}
main().catch((error) => { console.log(String(error?.stack ?? error)); process.exit(1); });
