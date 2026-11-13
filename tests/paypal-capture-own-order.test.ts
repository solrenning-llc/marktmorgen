/**
 * Issue #4444 (Codex X8, transcribed by Claude 2): PayPal's answer to an order's capture, or to reading it, holding
 * another order's completed record (same amount, currency and payee) never confirms this order. The answer must name
 * this order (Orders v2 `id`, and each capture's `up` link when it has one); otherwise the outcome is unknown: nothing
 * is written down or handed over, and the order stays in pending for the sweep to ask about again. Fixture copied
 * from tests/paypal-sales.test.ts (the PayPal stand-in shaped by checkout_orders_v2), every function real.
 */
import { TEST_CONSENT } from "./digital-consent-fixture";
import { claimHandle, ensureStatsId, addProduct, setProductLink, setSubscription, setPayPalSeller, storeForEmail } from "@/lib/store";
import { readListing } from "@/lib/catalog";
import { captureOrder, openOrder, readPaid, stillPending, watchPayPal } from "@/lib/paypal-sales";
import { importedFor } from "@/lib/imported-purchases";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";
import { paidPeriod } from "./billing-period-fixture";

const PARTNER_CLIENT = "AZpartnerClientId0123456789";
const PARTNER_SECRET = "EPpartnerSecret0123456789";
const PARTNER = "PARTNERMERCH01";
const BN = "NimbusLabs_SP";
const SELLER = "7KNGBPH2U58GQ";

type Seen = { method: string; path: string; body: Record<string, unknown> | null; headers: Headers };
const seen: Seen[] = [];
const emails: { to: string[]; subject: string; text: string }[] = [];
const integration: Record<string, unknown> = {};
const tracked = true;
/** What each order's capture does: an answer, or a status the stand-in fails with. */
let captureWith: (order: string) => { status: number; body: Record<string, unknown> } = () => ({ status: 500, body: {} });
const orders = new Map<string, Record<string, unknown>>();
const captures = new Map<string, string>();
let made = 0;
let paypalRequests = 0;

const orderId = (n: number) => `5O190127TN36471${String(n).padStart(2, "0")}`;

function completed(order: string, value: string, status = "COMPLETED", email = "Buyer@Example.com"): Record<string, unknown> {
  const cap = `3C679366HH9087${order.slice(-2)}${status === "PENDING" ? "P" : ""}`;
  captures.set(cap, status === "PENDING" ? "PENDING" : "COMPLETED");
  return {
    id: order,
    status: "COMPLETED",
    payer: { email_address: email, payer_id: "QYR5Z8XDVJNXQ" },
    purchase_units: [
      {
        reference_id: "x",
        payee: { merchant_id: SELLER },
        payments: { captures: [{ id: cap, status, amount: { currency_code: "USD", value } }] },
      },
    ],
  };
}

globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const url = new URL(String(input));
  const json = (v: unknown, status = 200) => new Response(JSON.stringify(v), { status });
  if (url.hostname === "api.resend.com") {
    emails.push(JSON.parse(String(init?.body)));
    return json({ id: "e" });
  }
  if (url.hostname !== "api-m.paypal.com") return json({ error: "unexpected" }, 404);
  paypalRequests++;
  const headers = new Headers(init?.headers);
  const method = init?.method ?? "GET";
  if (url.pathname === "/v1/oauth2/token") {
    const basic = Buffer.from(`${PARTNER_CLIENT}:${PARTNER_SECRET}`).toString("base64");
    if (headers.get("authorization") !== `Basic ${basic}`) return json({ error: "invalid_client" }, 401);
    return json({ access_token: "A21AApartner", token_type: "Bearer", expires_in: 32400 });
  }
  if (headers.get("authorization") !== "Bearer A21AApartner") return json({ name: "AUTHENTICATION_FAILURE" }, 401);
  const body = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : null;
  seen.push({ method, path: url.pathname + url.search, body, headers });

  if (url.pathname === "/v2/customer/partner-referrals" && method === "POST") {
    return json({ links: [{ href: "https://www.paypal.com/bizsignup/partner/entry?referralToken=abc", rel: "action_url", method: "GET" }] }, 201);
  }
  const integrations = `/v1/customer/partners/${PARTNER}/merchant-integrations`;
  if (url.pathname === integrations) {
    return tracked ? json({ merchant_id: SELLER, tracking_id: url.searchParams.get("tracking_id") }) : json({ name: "RESOURCE_NOT_FOUND" }, 404);
  }
  if (url.pathname === `${integrations}/${SELLER}`) return json(integration);
  if (url.pathname === "/v2/checkout/orders" && method === "POST") {
    made += 1;
    const id = orderId(made);
    orders.set(id, { id, status: "PAYER_ACTION_REQUIRED" });
    return json({ id, status: "PAYER_ACTION_REQUIRED", links: [{ href: `https://www.paypal.com/checkoutnow?token=${id}`, rel: "payer-action", method: "GET" }] });
  }
  const capture = /^\/v2\/checkout\/orders\/([A-Z0-9]+)\/capture$/.exec(url.pathname)?.[1];
  if (capture && method === "POST") {
    const answer = captureWith(capture);
    if (answer.status < 300) orders.set(capture, answer.body);
    return json(answer.body, answer.status);
  }
  const read = /^\/v2\/checkout\/orders\/([A-Z0-9]+)$/.exec(url.pathname)?.[1];
  if (read && method === "GET") return orders.has(read) ? json(orders.get(read)) : json({ name: "RESOURCE_NOT_FOUND" }, 404);
  const cap = /^\/v2\/payments\/captures\/([A-Z0-9]+)$/.exec(url.pathname)?.[1];
  if (cap && method === "GET") return json({ id: cap, status: captures.get(cap) ?? "COMPLETED" });
  return json({ name: "RESOURCE_NOT_FOUND" }, 404);
}) as typeof fetch;

async function main(): Promise<void> {
  redis.clear();
  process.env.RESEND_API_KEY = "re_test_paypal_sales";
  delete process.env.PAYPAL_ENV;
  process.env.PAYPAL_PARTNER_CLIENT_ID = PARTNER_CLIENT;
  process.env.PAYPAL_PARTNER_SECRET = PARTNER_SECRET;
  process.env.PAYPAL_PARTNER_MERCHANT_ID = PARTNER;
  process.env.PAYPAL_BN_CODE = BN;

  await claimHandle("owner@example.com", "harbor", "Harbor Kitchen", "");
  await ensureStatsId("owner@example.com");
  await setSubscription("owner@example.com", { customerId: "cus_Owner00001", subscriptionId: "sub_Owner00001", active: true, period: paidPeriod() });
  const added = await addProduct("owner@example.com", "Sourdough Guide", "", "49", null);
  if (!added.ok) throw new Error("no product");
  await setProductLink("owner@example.com", added.product.id, "https://example.com/guide");
  await setPayPalSeller("owner@example.com", SELLER);
  const store = (await storeForEmail("owner@example.com"))!;
  const product = (await readListing(store, added.product.id))!;
  const handed: string[] = [];
  const on = { handOver: async (p: { email: string; order: string }) => void handed.push(`${p.email}|${p.order}`), dropStart: async () => undefined };

  part("Another PayPal order's capture answer cannot confirm this order");
  const a = await openOrder(store, product, "https://marktmorgen.com", { digitalConsent: TEST_CONSENT });
  const b = await openOrder(store, product, "https://marktmorgen.com", { digitalConsent: TEST_CONSENT });
  if (!a.ok || !b.ok) throw new Error("no order");
  const answerOfB = completed(b.order, "49.00", "COMPLETED", "buyer-b@example.com");
  captureWith = () => ({ status: 201, body: answerOfB });
  const result = await captureOrder(store, a.order);
  is("capturing A with B's answer is not a success: unknown, asked again", result.ok ? "paid" : result.reason, "error");
  is("order A is not recorded as paid with B's capture", await readPaid(a.order), null);
  is("nothing is handed to B's buyer under A", (await importedFor(store, "buyer-b@example.com")).length, 0);
  is("order A stays in pending for the sweep", await stillPending(store, a.order), true);

  part("A capture whose own link names another order cannot confirm this order");
  const c = await openOrder(store, product, "https://marktmorgen.com", { digitalConsent: TEST_CONSENT });
  if (!c.ok) throw new Error("no order");
  captureWith = (o) => {
    const body = completed(o, "49.00", "COMPLETED", "buyer-c@example.com");
    const unit = (body.purchase_units as { payments: { captures: Record<string, unknown>[] } }[])[0];
    unit.payments.captures[0].links = [{ rel: "up", method: "GET", href: `https://api-m.paypal.com/v2/checkout/orders/${b.order}` }];
    return { status: 201, body };
  };
  const linked = await captureOrder(store, c.order);
  is("a capture of another order under this order's id is not a success", linked.ok ? "paid" : linked.reason, "error");
  is("and C is not recorded as paid", await readPaid(c.order), null);

  part("The sweep reads only this order's own record");
  // PayPal's reading of A answers with B's completed record, then with B voided: neither settles A nor lets it go.
  orders.set(a.order, answerOfB);
  let watched = await watchPayPal(store, Date.now() + 10_000, on);
  is("B's completed record does not settle A", [watched.cleared, handed, await readPaid(a.order)], [0, [], null]);
  is("A is kept to be asked again", await stillPending(store, a.order), true);
  orders.set(a.order, { id: b.order, status: "VOIDED" });
  await watchPayPal(store, Date.now() + 10_000, on);
  is("B voided does not let A go", await stillPending(store, a.order), true);

  part("This order's own answer still settles it");
  orders.set(a.order, completed(a.order, "49.00", "COMPLETED", "buyer-a@example.com"));
  watched = await watchPayPal(store, Date.now() + 10_000, on);
  is("A's own completed record settles A, once", [watched.cleared, handed], [1, [`buyer-a@example.com|${a.order}`]]);
  captureWith = (o) => ({ status: 201, body: completed(o, "49.00", "COMPLETED", "buyer-b@example.com") });
  const own = await captureOrder(store, b.order);
  is("B's own capture answer settles B", own.ok ? [own.fresh, own.paid.order, own.paid.email] : own.reason, [true, b.order, "buyer-b@example.com"]);
  is("the request counter moved", paypalRequests > 0, true);

  done();
}

void main();
