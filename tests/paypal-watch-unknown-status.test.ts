/**
 * Buyer area hunt (Claude 7, 14 November 2026; synthetic only): the PayPal refund watch (lib/paypal-sales.ts,
 * watchPayPal) read every capture status but REFUNDED as money standing, and past the watch's 180 days dropped the
 * order for good on it; a reply about another capture decided this one. Now only COMPLETED and PARTIALLY_REFUNDED
 * are standing and REFUNDED taken back; any other status, or another capture's reply, is unknown: looked at again in
 * an hour, never dropped, never counted as a refund.
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
/** A capture id the stand-in answers with instead of the one asked for (another capture's reply), or null. */
let answerAs: string | null = null;

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
  if (cap && method === "GET") return json({ id: answerAs ?? cap, status: captures.get(cap) ?? "COMPLETED" });
  return json({ name: "RESOURCE_NOT_FOUND" }, 404);
}) as typeof fetch;


async function main(): Promise<void> {
  redis.clear();
  process.env.RESEND_API_KEY = "re_test_probe_c";
  delete process.env.PAYPAL_ENV;
  await claimHandle("owner@example.com", "harbor", "Harbor Kitchen", "");
  await ensureStatsId("owner@example.com");
  await setSubscription("owner@example.com", { customerId: "cus_Owner00001", subscriptionId: "sub_Owner00001", active: true, period: paidPeriod() });
  const added = await addProduct("owner@example.com", "Sourdough Guide", "", "49", null);
  if (!added.ok) throw new Error("no product");
  await setProductLink("owner@example.com", added.product.id, "https://example.com/guide");
  process.env.PAYPAL_PARTNER_CLIENT_ID = PARTNER_CLIENT;
  process.env.PAYPAL_PARTNER_SECRET = PARTNER_SECRET;
  process.env.PAYPAL_PARTNER_MERCHANT_ID = PARTNER;
  process.env.PAYPAL_BN_CODE = BN;
  await setPayPalSeller("owner@example.com", SELLER);
  let store = (await storeForEmail("owner@example.com"))!;
  const product = (await readListing(store, added.product.id))!;
  const sale = await openOrder(store, product, "https://marktmorgen.com", { digitalConsent: TEST_CONSENT });
  if (!sale.ok) throw new Error("no order");
  captureWith = (o) => ({ status: 201, body: completed(o, "49.00") });
  const paid = await captureOrder(store, sale.order);
  if (!paid.ok) throw new Error("not paid");
  await handOverPayPal(store, paid.paid);
  store = (await storeForEmail("owner@example.com"))!;
  const on = { handOver: async () => {}, dropStart: async () => {} };
  const watchKey = `nl:ppsell:watch:${store.statsId}`;

  const refundedKey = `nl:ppsell:refunded:${store.statsId}`;
  const nowS = () => Math.floor(Date.now() / 1000);
  const look = async () => {
    await redis.pipeline([["ZADD", watchKey, "0", sale.order]]);
    await watchPayPal(store, Date.now() + 10_000, on);
    const score = (await redis.pipeline([["ZSCORE", watchKey, sale.order]]))[0];
    return { watched: score !== null, inSeconds: score === null ? null : Number(score) - nowS(), refunded: (await redis.pipeline([["ZSCORE", refundedKey, sale.order]]))[0] !== null, kept: (await importedFor(store, "buyer@example.com")).length };
  };
  const grantBefore = (await importedFor(store, "buyer@example.com")).length;
  is("the sale is granted to begin with", grantBefore > 0, true);

  part("A capture status the watch does not read is unknown: looked at again in an hour, never counted as a refund");
  // REVERSED, DECLINED and FAILED are no longer unknown here: main's C4-13 (the owner, 4 November 2026) takes the
  // purchase back on each, held by tests/paypal-reversed-access.test.ts. The unknown ones are statuses PayPal does not
  // publish for a capture.
  for (const status of ["SOMETHING_NEW", "UNDER_REVIEW", "ON_HOLD", "VOIDED_LATER"]) {
    captures.set(paid.paid.capture, status);
    const seen = await look();
    is(`status ${status}: still watched, an hour on, not counted as a refund`, [seen.watched, seen.inSeconds !== null && seen.inSeconds <= 3600 && seen.inSeconds > 3500, seen.refunded], [true, true, false]);
  }

  part("Another capture's reply decides nothing");
  captures.set(paid.paid.capture, "REFUNDED");
  answerAs = "9ZZ99999ZZ9999999";
  const foreign = await look();
  answerAs = null;
  is("a REFUNDED reply about another capture: still watched an hour on, nothing taken back", [foreign.watched, foreign.refunded, foreign.kept], [true, false, grantBefore]);

  part("Past the watch's 180 days, an unknown status is still never dropped");
  captures.set(paid.paid.capture, "SOMETHING_NEW");
  const raw = (await redis.pipeline([["GET", `nl:ppsell:paid:${sale.order}`]]))[0] as string;
  const rec = JSON.parse(raw);
  rec.at = nowS() - 181 * 86_400;
  await redis.pipeline([["SET", `nl:ppsell:paid:${sale.order}`, JSON.stringify(rec)]]);
  const old = await look();
  is("an unknown status past 180 days stays watched", old.watched, true);
  captures.set(paid.paid.capture, "COMPLETED");
  const standing = await look();
  is("a COMPLETED capture past 180 days leaves the watch, as before", standing.watched, false);

  part("A capture refunded in full is still taken back");
  rec.at = nowS() - 86_400;
  await redis.pipeline([["SET", `nl:ppsell:paid:${sale.order}`, JSON.stringify(rec)]]);
  captures.set(paid.paid.capture, "REFUNDED");
  const back = await look();
  is("REFUNDED: counted as a refund and the grant taken back", [back.refunded, back.kept], [true, 0]);
  done();
}
void main();
