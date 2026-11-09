// Codex G's proof on #2791 (codex/g-review-2791-paid-record-return ddb288ae), kept as a permanent test with credit.
/** G independent proof; derived from author PayPal stand-in fixture, all grant and refund functions real. */
/**
 * Selling with PayPal: the buyer pays the creator's own PayPal account.
 *
 * Measured before it was built (1 October 2026): Stan's buyers can pay with
 * PayPal into the creator's own PayPal (help.stan.store). What is checked,
 * against a stand-in for PayPal's API shaped by its published OpenAPI
 * descriptions (checkout_orders_v2, customer_partner_referrals_v2,
 * payments_payment_v2) and its onboarding guide:
 *
 *   - off, everywhere, until the partner credentials are set;
 *   - a creator's account is taken only as PayPal reports it, by the store's
 *     own tracking id, with its permissions granted, its email confirmed and
 *     payments receivable;
 *   - what can be sold, and that the plan opens this till as it does Stripe's;
 *   - the order names the creator's account as payee, at the store's price
 *     less a running sale, with PayPal's partner and idempotency headers;
 *   - the payment is taken for the creator (PayPal-Auth-Assertion), checked
 *     against the order, written down once, handed over once, with a receipt;
 *   - a declined or mismatched payment hands nothing over; a pending one, or
 *     one whose answer was lost, is handed over when PayPal completes it;
 *   - a full refund takes it back, unless another payment of theirs stands.
 */
import { TEST_CONSENT } from "./digital-consent-fixture";
import { claimHandle, ensureStoreId, ensureStatsId, addProduct, setProductLink, setSubscription, setPayPalSeller, storeForEmail, type Listing, type Store } from "@/lib/store";
import { readListing } from "@/lib/catalog";
import { CURRENCIES } from "@/lib/money";
import {
  PAYPAL_CURRENCIES,
  authAssertion,
  captureOrder,
  checkSeller,
  nextLook,
  onboardingUrl,
  openOrder,
  paypalReady,
  paypalSalesConfigured,
  readPaid,
  referralBody,
  sellsWithPayPal,
  stillPending,
  takenBy,
  watchPayPal,
} from "@/lib/paypal-sales";
import { handOverPayPal } from "@/lib/paypal-delivery";
import { importedFor } from "@/lib/imported-purchases";
import { chargedLine, purchasesFor } from "@/lib/buyer-orders";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";
import { paidPeriod } from "./billing-period-fixture";
import { NextRequest } from "next/server";
import { openSession, SESSION_COOKIE } from "@/lib/auth";
import { GET as returnPayPalSeller } from "@/app/api/store/paypal/onboarded/route";

const PARTNER_CLIENT = "AZpartnerClientId0123456789";
const PARTNER_SECRET = "EPpartnerSecret0123456789";
const PARTNER = "PARTNERMERCH01";
const BN = "NimbusLabs_SP";
const SELLER = "7KNGBPH2U58GQ";

type Seen = { method: string; path: string; body: Record<string, unknown> | null; headers: Headers };
const seen: Seen[] = [];
const emails: { to: string[]; subject: string; text: string }[] = [];
let integration: Record<string, unknown> = {};
let tracked = true;
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

const base = (over: Partial<Listing>): Listing =>
  ({ id: "x", priceCents: 2900, hidden: false, stock: null, recurring: null, call: null, pwyw: null, keys: null, options: [], file: null, link: "https://example.com", course: null, podcast: null, bundle: null, ...over }) as Listing;

const decode = (part: string) => JSON.parse(Buffer.from(part, "base64url").toString()) as Record<string, unknown>;

async function main(): Promise<void> {
  redis.clear();
  process.env.RESEND_API_KEY = "re_test_paypal_sales";
  delete process.env.PAYPAL_ENV;

  await claimHandle("owner@example.com", "harbor", "Harbor Kitchen", "");
  await ensureStatsId("owner@example.com");
  await setSubscription("owner@example.com", { customerId: "cus_Owner00001", subscriptionId: "sub_Owner00001", active: true, period: paidPeriod() });
  const added = await addProduct("owner@example.com", "Sourdough Guide", "", "49", null);
  if (!added.ok) throw new Error("no product");
  await setProductLink("owner@example.com", added.product.id, "https://example.com/guide");
  let store = (await storeForEmail("owner@example.com"))!;
  const product = (await readListing(store, added.product.id))!;

  part("Off until Marktmorgen is an approved PayPal partner");
  is("not configured", paypalSalesConfigured(), false);
  is("so no product takes PayPal, even with an account set", paypalReady({ ...store, paypalSeller: { merchant: SELLER, at: 1 } }, product), false);
  process.env.PAYPAL_PARTNER_CLIENT_ID = PARTNER_CLIENT;
  process.env.PAYPAL_PARTNER_SECRET = PARTNER_SECRET;
  process.env.PAYPAL_PARTNER_MERCHANT_ID = PARTNER;
  process.env.PAYPAL_BN_CODE = BN;
  is("on with the four credentials", paypalSalesConfigured(), true);

  part("Connecting the creator's PayPal");
  const referral = referralBody(store, "https://marktmorgen.com/api/store/paypal/onboarded?store=x");
  is("tracked by the store's own id", referral.tracking_id, store.statsId);
  is("asking for taking payments and refunding them, nothing else", (referral.operations as { api_integration_preference: { rest_api_integration: { third_party_details: { features: string[] } } } }[])[0].api_integration_preference.rest_api_integration.third_party_details.features, ["PAYMENT", "REFUND"]);
  is("the fields PayPal requires", [Array.isArray(referral.operations), (referral.legal_consents as { type: string; granted: boolean }[])[0]], [true, { type: "SHARE_DATA_CONSENT", granted: true }]);
  is("PayPal's own page to send them to", await onboardingUrl(store, "https://marktmorgen.com/x"), "https://www.paypal.com/bizsignup/partner/entry?referralToken=abc");
  const third = { integration_type: "OAUTH_THIRD_PARTY", integration_method: "PAYPAL", oauth_third_party: [{ partner_client_id: PARTNER_CLIENT, merchant_client_id: "AXm", scopes: [] }] };
  tracked = false;
  is("nothing finished under the store's id", await checkSeller(store.statsId!), { ok: false, reason: "id" });
  tracked = true;
  integration = { merchant_id: SELLER, tracking_id: store.statsId, payments_receivable: true, primary_email_confirmed: true, oauth_integrations: [] };
  is("permissions not granted", await checkSeller(store.statsId!), { ok: false, reason: "permissions" });
  integration = { ...integration, oauth_integrations: [third], primary_email_confirmed: false };
  is("email not confirmed", await checkSeller(store.statsId!), { ok: false, reason: "email" });
  integration = { ...integration, primary_email_confirmed: true, payments_receivable: false };
  is("cannot receive payments", await checkSeller(store.statsId!), { ok: false, reason: "receivable" });
  integration = { ...integration, payments_receivable: true, tracking_id: "someone-else" };
  is("another store's account", await checkSeller(store.statsId!), { ok: false, reason: "id" });
  integration = { ...integration, tracking_id: store.statsId };
  is("ready", await checkSeller(store.statsId!), { ok: true, merchant: SELLER });
  is("an id that is not PayPal's is not kept", await setPayPalSeller("owner@example.com", "not-an-id"), null);
  await setPayPalSeller("owner@example.com", SELLER);
  store = (await storeForEmail("owner@example.com"))!;
  is("kept on the store", store.paypalSeller?.merchant, SELLER);

  part("What can be sold with PayPal");
  is("a paid download", sellsWithPayPal(base({})), true);
  is("not something free", sellsWithPayPal(base({ priceCents: 0 })), false);
  is("not a membership", sellsWithPayPal(base({ recurring: { interval: "month" } as Listing["recurring"] })), false);
  is("not a call", sellsWithPayPal(base({ call: {} as Listing["call"] })), false);
  is("not with price options", sellsWithPayPal(base({ options: [{}] as Listing["options"] })), false);
  is("not pay what you want", sellsWithPayPal(base({ pwyw: {} as Listing["pwyw"] })), false);
  is("not with license keys", sellsWithPayPal(base({ keys: {} as Listing["keys"] })), false);
  is("not limited stock", sellsWithPayPal(base({ stock: 5 } as Partial<Listing>)), false);
  is("not a draft", sellsWithPayPal(base({ hidden: true })), false);
  is("not something that hands over nothing", sellsWithPayPal(base({ link: null })), false);
  is("this store's guide, on its plan, without Stripe", paypalReady(store, product), true);
  is("the plan opens this till too", paypalReady({ ...store, subscriptionActive: false }, product), false);
  is("every currency a store sells in is one PayPal takes", CURRENCIES.every((c) => PAYPAL_CURRENCIES.has(c.code)), true);
  is("the store's pages say who takes it", [takenBy(true, true), takenBy(false, true), takenBy(true, false)], ["Stripe or PayPal", "PayPal", "Stripe"]);

  part("The order");
  const now = Math.floor(Date.now() / 1000);
  const onSale: Store = { ...store, sale: { ...store.sale, percent: 20, starts: now - 60, ends: now + 3600, all: true, products: [], coupon: "c_sale" } as Store["sale"] };
  // Without the box to start access before the 14 days end (lib/digital-consent.ts): refused before an order is admitted or PayPal is asked.
  const unasked = await openOrder(onSale, product, "https://marktmorgen.com");
  const forgedYes = await openOrder(onSale, product, "https://marktmorgen.com", { digitalConsent: { ...TEST_CONSENT, version: "2020-01-01.1" } });
  is("no yes, or a yes of another version: no PayPal order", [unasked.ok ? "opened" : unasked.reason, forgedYes.ok ? "opened" : forgedYes.reason], ["consent", "consent"]);
  const first = await openOrder(onSale, product, "https://marktmorgen.com", { digitalConsent: TEST_CONSENT });
  is("sent to PayPal's page", first.ok ? first.url : first.reason, `https://www.paypal.com/checkoutnow?token=${orderId(1)}`);
  const sent = seen.find((s) => s.path === "/v2/checkout/orders")!;
  const unit = (sent.body!.purchase_units as Record<string, unknown>[])[0];
  is("paid into the creator's account", unit.payee, { merchant_id: SELLER });
  is("at the store's price less the running sale", unit.amount, { currency_code: "USD", value: "39.20" });
  is("captured at once, nothing shipped", [sent.body!.intent, (sent.body!.payment_source as { paypal: { experience_context: Record<string, string> } }).paypal.experience_context.shipping_preference], ["CAPTURE", "NO_SHIPPING"]);
  is("with PayPal's partner and idempotency headers", [sent.headers.get("paypal-partner-attribution-id"), Boolean(sent.headers.get("paypal-request-id"))], [BN, true]);
  const allowedUnit = ["reference_id", "description", "custom_id", "invoice_id", "soft_descriptor", "items", "amount", "payee", "payment_instruction", "shipping", "supplementary_data"];
  is("only fields PayPal's description has", [Object.keys(sent.body!).every((k) => ["intent", "payer", "purchase_units", "payment_source", "application_context"].includes(k)), Object.keys(unit).every((k) => allowedUnit.includes(k))], [true, true]);

  part("Declined");
  captureWith = () => ({ status: 422, body: { name: "UNPROCESSABLE_ENTITY", details: [{ issue: "INSTRUMENT_DECLINED" }] } });
  const declined = await captureOrder(store, orderId(1));
  is("nothing is handed over", [declined.ok ? "paid" : declined.reason, (await importedFor((await storeForEmail("owner@example.com"))!, "buyer@example.com")).length], ["declined", 0]);

  part("Paid");
  const second = await openOrder(store, product, "https://marktmorgen.com", { digitalConsent: TEST_CONSENT });
  if (!second.ok) throw new Error("no order");
  captureWith = (o) => ({ status: 201, body: completed(o, "49.00") });
  const paid = await captureOrder(store, second.order);
  const capture = seen.filter((s) => s.path.endsWith("/capture")).at(-1)!;
  const [head, claims, tail] = String(capture.headers.get("paypal-auth-assertion")).split(".");
  is("taken for the creator's account, as PayPal's assertion says", [decode(head), decode(claims), tail], [{ alg: "none" }, { iss: PARTNER_CLIENT, payer_id: SELLER }, ""]);
  is("the assertion helper itself", authAssertion("a", "B").split(".").length, 3);
  if (!paid.ok) throw new Error(`not paid: ${paid.reason}`);
  is("written down once, under the buyer's PayPal address", [paid.fresh, paid.paid.email, paid.paid.cents, paid.paid.store], [true, "buyer@example.com", 4900, store.statsId]);
  await handOverPayPal(store, paid.paid);
  store = (await storeForEmail("owner@example.com"))!;
  is("theirs on this store", (await importedFor(store, "buyer@example.com")).map((p) => [p.productId, p.job]), [[product.id, `paypal:${second.order}`]]);
  const receipt = emails.at(-1)!;
  is("one receipt, with the way in and who was paid", [emails.length, receipt.to[0], receipt.text.includes("/orders?token="), receipt.text.includes("Paid with PayPal: $49"), receipt.text.includes("own PayPal account")], [1, "buyer@example.com", true, true, true]);
  const again = await captureOrder(store, second.order);
  is("back again: nothing taken twice", again.ok ? again.fresh : again.reason, false);
  const listed = await purchasesFor(store, "buyer@example.com");
  is("on their list as bought and paid with PayPal", listed.map((p) => [p.title, p.paidWith, p.giftFrom ?? null]), [["Sourdough Guide", "paypal", null]]);
  is("and the list's email says who charged it", chargedLine("Harbor Kitchen", listed), "Every purchase was charged by Harbor Kitchen on their own Stripe or PayPal account.");

  part("Not what was asked");
  const third3 = await openOrder(store, product, "https://marktmorgen.com", { digitalConsent: TEST_CONSENT });
  if (!third3.ok) throw new Error("no order");
  captureWith = (o) => ({ status: 201, body: completed(o, "1.00", "COMPLETED", "other@example.com") });
  const wrong = await captureOrder(store, third3.order);
  is("a different amount hands nothing over", [wrong.ok ? "paid" : wrong.reason, (await importedFor(store, "other@example.com")).length], ["mismatch", 0]);
  is("an order of another store is not taken here", (await captureOrder({ ...store, statsId: "another" }, third3.order)).ok, false);

  part("Pending, or the answer lost");
  const fourth = await openOrder(store, product, "https://marktmorgen.com", { digitalConsent: TEST_CONSENT });
  const fifth = await openOrder(store, product, "https://marktmorgen.com", { digitalConsent: TEST_CONSENT });
  if (!fourth.ok || !fifth.ok) throw new Error("no order");
  captureWith = (o) => ({ status: 201, body: completed(o, "49.00", "PENDING", "slow@example.com") });
  is("a pending payment hands nothing over yet", (await captureOrder(store, fourth.order)).ok, false);
  is("and is waited on", await stillPending(store, fourth.order), true);
  captureWith = () => ({ status: 500, body: { name: "INTERNAL_SERVER_ERROR" } });
  is("an answer lost on the way", (await captureOrder(store, fifth.order)).ok ? "paid" : "error", "error");
  orders.set(fifth.order, completed(fifth.order, "49.00", "COMPLETED", "lost@example.com"));
  const seventh = await openOrder(store, product, "https://marktmorgen.com", { digitalConsent: TEST_CONSENT });
  if (!seventh.ok) throw new Error("no order");
  orders.set(seventh.order, completed(seventh.order, "49.00", "COMPLETED", "early@example.com"));
  captureWith = () => ({ status: 422, body: { name: "UNPROCESSABLE_ENTITY", details: [{ issue: "ORDER_ALREADY_CAPTURED" }] } });
  const early = await captureOrder(store, seventh.order);
  is("taken already, by a request that never wrote it down: PayPal's order settles it", early.ok ? [early.fresh, early.paid.email] : early.reason, [true, "early@example.com"]);
  const handed: string[] = [];
  const dropped: string[] = [];
  const on = { handOver: async (p: { email: string; order: string }) => void handed.push(`${p.email}|${p.order}`), dropStart: async (e: string, id: string) => void dropped.push(`${e}|${id}`) };
  let watched = await watchPayPal(store, Date.now() + 10_000, on);
  is("PayPal took the lost one: handed over; the pending one waits", [watched.cleared, handed], [1, [`lost@example.com|${fifth.order}`]]);
  orders.set(fourth.order, completed(fourth.order, "49.00", "COMPLETED", "slow@example.com"));
  // Its turn made to come now (assertion unchanged): since the pending backoff (Claude 2's MEDIUM on #3404) the sweep
  // asks a kept order again only at its next look (nextPendingLook), five minutes on for one this new.
  redis.run(["ZADD", `nl:ppsell:pending:${store.statsId}`, "1", fourth.order]);
  watched = await watchPayPal(store, Date.now() + 10_000, on);
  is("then the pending one, once PayPal completes it", [watched.cleared, handed.at(-1), await stillPending(store, fourth.order)], [1, `slow@example.com|${fourth.order}`, false]);
  is("asked again, nothing twice", (await watchPayPal(store, Date.now() + 10_000, on)).cleared, 0);

  part("Refunds");
  is("asked often at first, then less, until PayPal's 180 days", [nextLook(0, 60), nextLook(0, 10 * 86_400), nextLook(0, 40 * 86_400), nextLook(0, 181 * 86_400)], [3660, 10 * 86_400 + 21_600, 40 * 86_400 + 86_400, null]);
  // The same buyer pays twice for the same guide; the first is refunded.
  const sixth = await openOrder(store, product, "https://marktmorgen.com", { digitalConsent: TEST_CONSENT });
  if (!sixth.ok) throw new Error("no order");
  captureWith = (o) => ({ status: 201, body: completed(o, "49.00") });
  const twice = await captureOrder(store, sixth.order);
  if (!twice.ok) throw new Error("not paid");
  await handOverPayPal(store, twice.paid);
  const due = async () => {
    await redis.pipeline([["ZADD", `nl:ppsell:watch:${store.statsId}`, "0", second.order], ["ZADD", `nl:ppsell:watch:${store.statsId}`, "0", sixth.order]]);
  };
  captures.set(paid.paid.capture, "PARTIALLY_REFUNDED");
  await due();
  is("a partial refund keeps it", [(await watchPayPal(store, Date.now() + 10_000, on)).revoked, (await importedFor(store, "buyer@example.com")).length], [0, 1]);
  captures.set(paid.paid.capture, "REFUNDED");
  await due();
  is("the first refunded in full: the second payment keeps it", (await watchPayPal(store, Date.now() + 10_000, on)).revoked, 0);
  is("now standing on the second", (await importedFor(store, "buyer@example.com")).map((p) => p.job), [`paypal:${sixth.order}`]);
  captures.set(twice.paid.capture, "REFUNDED");
  await due();
  part("G: unknown paid-record GET envelope must keep the watch and the purchase");
  await redis.pipeline([["ZREM", `nl:ppsell:watch:${store.statsId}`, second.order]]);
  const actualPipeline = redis.pipeline.bind(redis);
  const mode = process.env.G_REPLY ?? "extra";
  let injected = 0;
  redis.pipeline = async (commands: (string | number)[][]) => {
    if (commands.length === 1 && commands[0]?.[0] === "GET" && commands[0]?.[1] === `nl:ppsell:paid:${sixth.order}`) {
      injected += 1;
      // One command, two replies: unknown envelope, not confirmed missing.
      return mode === "extra" ? [null, 1] : mode === "queued" ? ["QUEUED"] : mode === "empty" ? [] : actualPipeline(commands);
    }
    return actualPipeline(commands);
  };
  try { await watchPayPal(store, Date.now() + 10_000, on); }
  finally { redis.pipeline = actualPipeline; }
  is("G: exact transport boundary was reached", injected, 1);
  is("G: purchase state after the first run", (await importedFor(store, "buyer@example.com")).length, mode === "control" ? 0 : 1);
  const watchAfterUnknown = (await redis.pipeline([["ZRANGEBYSCORE", `nl:ppsell:watch:${store.statsId}`, "-inf", "+inf"]]))[0];
  is("G: unknown receipt keeps this order on the watch", Array.isArray(watchAfterUnknown) && watchAfterUnknown.includes(sixth.order), mode !== "control");
  const originalNow = Date.now;
  Date.now = () => originalNow() + 3_601_000;
  await watchPayPal(store, Date.now() + 10_000, on);
  Date.now = originalNow;
  const remaining = await importedFor(store, "buyer@example.com");
  const actualPurchases = await purchasesFor({ ...store, stripeAccountId: null }, "buyer@example.com");
  console.log("G_PAYPAL_AFTER_HEALTHY_RETRY", JSON.stringify({ mode, injected, watchAfterUnknown, imported: remaining.length, purchases: actualPurchases.map(p => p.title), dropped }));
  is("G: healthy retry removes the refunded purchase", remaining.length, 0);
  done();
}
void main();
