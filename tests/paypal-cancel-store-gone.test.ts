/**
 * A canceled PayPal order's buyer is told even when the store is gone before the notice goes (finding on #3924):
 * the sender refused the buyer's notice at the cancellation, then the store was deleted (or its address went to
 * another store). retryPayPalCancelNotices used to drop the notice from the queue with nobody told; now the buyer
 * is told from Marktmorgen, in the language the store spoke when the order was canceled, without a link to a store
 * that is no longer there, and with replies going to Marktmorgen support. The creator's own notice, with no store
 * to write to, leaves the queue as before.
 *
 * Real job (sweepCheckouts); synthetic only: a PayPal stand-in, a Resend stand-in and the Redis stub.
 */
import { TEST_CONSENT } from "./digital-consent-fixture";
import { addProduct, claimHandle, closeStoreRecord, disconnectPayPalSeller, ensureStatsId, setLanguage, setPayPalSeller, setProductLink, setSubscription, storeForEmail } from "@/lib/store";
import { readListing } from "@/lib/catalog";
import { captureOrder, openOrder, readPaid, stillPending } from "@/lib/paypal-sales";
import { PAYPAL_CANCEL_WORDS } from "@/lib/buyer-words/paypal-cancel";
import { sweepCheckouts } from "@/lib/checkout-sweep";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";
import { paidPeriod } from "./billing-period-fixture";

const SELLER = "7KNGBPH2U58GQ";
const orders = new Map<string, Record<string, unknown>>();
const emails: { to: string[]; subject: string; text: string; html?: string }[] = [];
let captureWith: (order: string) => Record<string, unknown> = () => ({});
let made = 0;
const orderId = (n: number) => `7E190127TN36471${String(n).padStart(2, "0")}`;

function pending(order: string, email: string | null): Record<string, unknown> {
  return {
    id: order,
    status: "COMPLETED",
    ...(email ? { payer: { email_address: email } } : {}),
    purchase_units: [{ payee: { merchant_id: SELLER }, payments: { captures: [{ id: `5C679366HH9087${order.slice(-2)}`, status: "PENDING", amount: { currency_code: "USD", value: "49.00" } }] } }],
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
  if (read && method === "GET") return orders.has(read) ? json(orders.get(read)) : json({ name: "RESOURCE_NOT_FOUND" }, 404);
  return json({ name: "RESOURCE_NOT_FOUND" }, 404);
}) as typeof fetch;

async function openedDaysAgo(order: string, days: number): Promise<void> {
  const key = `nl:ppsell:o:${order}`;
  const [raw] = await redis.pipeline([["GET", key]]);
  const opened = JSON.parse(String(raw)) as { at: number };
  opened.at = Math.floor(Date.now() / 1000) - days * 86_400;
  await redis.pipeline([["SET", key, JSON.stringify(opened), "EX", 86_400]]);
}

const to = (address: string) => emails.filter((e) => e.to.includes(address));
const KEY = "re_test_paypal_sales";

async function main(): Promise<void> {
  redis.clear();
  console.error = () => {};
  delete process.env.PAYPAL_ENV;
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
  await setLanguage("owner@example.com", "de");
  let store = (await storeForEmail("owner@example.com"))!;
  const product = (await readListing(store, added.product.id))!;
  const opened = await openOrder(store, product, "https://marktmorgen.com", { digitalConsent: TEST_CONSENT });
  if (!opened.ok) throw new Error(`no order: ${opened.reason}`);
  const order = opened.order;
  captureWith = (o) => pending(o, "gone@example.com");
  await captureOrder(store, order);
  await disconnectPayPalSeller("owner@example.com");
  store = (await storeForEmail("owner@example.com"))!;
  await openedDaysAgo(order, 30);

  part("Canceled while the sender refuses: the buyer's notice waits");
  delete process.env.RESEND_API_KEY;
  await sweepCheckouts(Date.now() + 20_000);
  is("canceled, nothing handed over", [await stillPending(store, order), await readPaid(order)], [false, null]);
  const [queued] = await redis.pipeline([["ZSCORE", "nl:ppsell:tell", order]]);
  is("control: the buyer's notice waits on the queue", queued !== null, true);
  is("nobody emailed yet", emails.length, 0);

  part("The store is deleted before the notice goes");
  await closeStoreRecord(store);
  is("control: the store is gone", await storeForEmail("owner@example.com"), null);
  process.env.RESEND_API_KEY = KEY;
  await redis.pipeline([["ZADD", "nl:ppsell:tell", "XX", "1", order, "1", `c:${order}`]]);
  await sweepCheckouts(Date.now() + 20_000);
  const sent = to("gone@example.com") as (typeof emails[number] & { from?: string; reply_to?: string | string[] })[];
  is("the buyer is still told", sent.length, 1);
  is("in the language the store spoke, with a text and an HTML part", [sent[0]?.subject, sent[0]?.html?.includes('lang="de-DE"'), sent[0]?.text.includes(PAYPAL_CANCEL_WORDS.de.heading)], ["Ihre PayPal-Bestellung für Ihre Bestellung wurde storniert", true, true]);
  is("naming the store it was ordered from", sent[0]?.text.includes("Harbor Kitchen"), true);
  is("from Marktmorgen, replies to Marktmorgen support", [/marktmorgen/i.test(String(sent[0]?.from)), String(sent[0]?.reply_to)], [true, "support@marktmorgen.com"]);
  is("never a link to the store that is gone", /\/@harbor|\/p\//.test(sent[0]?.text ?? ""), false);
  is("never asks to reply to reach the store", sent[0]?.text.includes(PAYPAL_CANCEL_WORDS.de.questions("Harbor Kitchen")), false);
  const [left] = await redis.pipeline([["ZCARD", "nl:ppsell:tell"]]);
  is("nothing left on the queue", left, 0);
  is("the creator, with no store, is not written to", to("owner@example.com").length, 0);
  done();
}

main().catch((error) => {
  console.log("✗ crashed:", error);
  process.exit(1);
});
