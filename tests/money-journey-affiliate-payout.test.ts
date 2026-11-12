/**
 * Money journey, end to end: an affiliate's commission, from the click to the
 * money in their PayPal (C2-159 item 4, part 2). The other tests check each
 * step on its own (tests/affiliate-attribution.test.ts,
 * tests/affiliate-commission.test.ts, tests/paypal-payouts.test.ts); this
 * one walks through all of them in order, with the real code at every step
 * and only Stripe, PayPal and the email sender simulated:
 *
 *   1. the creator runs a program at 30%, paid with no wait;
 *   2. somebody asks to join, opens the link emailed to them and is approved:
 *      they have a code;
 *   3. a buyer follows the affiliate's link (the click cookie the proxy
 *      writes) and pays for a $100 course through the real checkout route
 *      (POST /api/store/checkout): the checkout names the affiliate and the
 *      rate, and Stripe takes $100;
 *   4. the sale is written down (the thanks page's noteSession): the book
 *      says $30 earned and payable, and writing it again changes nothing;
 *   5. a buyer with no click earns nobody anything;
 *   6. a second sale through the link is refunded in full at Stripe before
 *      payday: it earns nothing, and the book still says $30;
 *   7. the creator's PayPal pays: one item of $30.00 to the affiliate's
 *      address, never twice while it is on its way, and once PayPal says it
 *      succeeded the book says paid and nothing more is owed.
 *
 * Each step reads what the one before wrote, so a break anywhere fails the
 * journey. Synthetic data only: no real Stripe, PayPal, email or Redis.
 */
import { NextRequest } from "next/server";
import { POST as checkoutRoute } from "@/app/api/store/checkout/route";
import { decide, noteSession, openAffiliateLink, readBook, requestAffiliateLink } from "@/lib/affiliates";
import { viaCookieName, viaCookieValue } from "@/lib/affiliate-setting";
import { connectPayPal, payWithPayPal, settlePayPal } from "@/lib/paypal-payouts";
import { addProduct, claimHandle, ensureStatsId, setAffiliateSetting, setProductLink, setStripeAccount, setSubscription, storeForEmail } from "@/lib/store";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";
import { paidPeriod } from "./billing-period-fixture";
import { withConsent } from "./digital-consent-fixture";

const OWNER = "loom@example.com";
const HANDLE = "loomstudio";
const ACCOUNT = "acct_1TestLoomAff001";
const AFFILIATE = "mia@example.com";
const CLIENT = "AbCdEfGhIjKlMnOpQrStUvWxYz0123456789";
const SECRET = "EFGHijklMNOPqrstUVWXyz0123456789abcd";

const opened: { id: string; body: URLSearchParams; account: string | null }[] = [];
const sessions = new Map<string, Record<string, unknown>>();
/** Refunds on the creator's Stripe account, as /v1/refunds lists them. */
const refunds: Record<string, unknown>[] = [];
const emails: { to: string[]; subject: string; text: string }[] = [];
/** Batches sent to the creator's PayPal, and what PayPal says of each item. */
const batches: { body: Record<string, unknown>; requestId: string | null }[] = [];
let itemStatus = "PENDING";
const answer = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });

globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const url = new URL(String(input));
  const method = init?.method ?? "GET";
  if (url.hostname === "api.resend.com") {
    emails.push(JSON.parse(String(init?.body)));
    return answer({ id: `email_${emails.length}` });
  }
  if (url.hostname === "api-m.paypal.com") {
    const headers = new Headers(init?.headers);
    if (url.pathname === "/v1/oauth2/token") {
      if (headers.get("authorization") !== `Basic ${Buffer.from(`${CLIENT}:${SECRET}`).toString("base64")}`) return answer({ error: "invalid_client" }, 401);
      return answer({ access_token: "A21AAjourney", token_type: "Bearer", scope: "https://uri.paypal.com/payments/payouts openid", expires_in: 32400 });
    }
    if (headers.get("authorization") !== "Bearer A21AAjourney") return answer({ name: "AUTHENTICATION_FAILURE" }, 401);
    if (url.pathname === "/v1/payments/payouts" && method === "POST") {
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      batches.push({ body, requestId: headers.get("paypal-request-id") });
      return answer({ batch_header: { payout_batch_id: `BATCH${batches.length}JRN`, batch_status: "PENDING", sender_batch_header: body.sender_batch_header } }, 201);
    }
    const batch = /^\/v1\/payments\/payouts\/BATCH(\d+)JRN$/.exec(url.pathname);
    if (batch) {
      const items = batches[Number(batch[1]) - 1].body.items as { sender_item_id: string; amount: unknown; receiver: string }[];
      return answer({
        batch_header: { payout_batch_id: `BATCH${batch[1]}JRN`, batch_status: "SUCCESS" },
        total_pages: 1,
        items: items.map((item, i) => ({ payout_item_id: `ITEM${batch[1]}JRN${i}`, payout_batch_id: `BATCH${batch[1]}JRN`, transaction_status: itemStatus, payout_item: item })),
      });
    }
    return answer({ name: "RESOURCE_NOT_FOUND" }, 404);
  }
  if (url.hostname !== "api.stripe.com") return answer({}, 404);
  if (url.pathname === "/v1/checkout/sessions" && method === "POST") {
    const id = `cs_test_journeyaff${String(opened.length + 1).padStart(6, "0")}`;
    opened.push({ id, body: new URLSearchParams(String(init?.body)), account: new Headers(init?.headers).get("Stripe-Account") });
    sessions.set(id, { id, object: "checkout.session", status: "open", payment_status: "unpaid" });
    return answer({ id, url: `https://checkout.stripe.com/c/pay/${id}` });
  }
  const one = /^\/v1\/checkout\/sessions\/([^/]+)$/.exec(url.pathname);
  if (one && method === "GET") {
    const found = sessions.get(decodeURIComponent(one[1]));
    return found ? answer(found) : answer({ error: { message: "No such checkout.session" } }, 404);
  }
  if (url.pathname === "/v1/refunds" && method === "GET") return answer({ object: "list", data: refunds, has_more: false });
  return answer({ object: "list", data: [], has_more: false });
}) as typeof fetch;

/** What was sent as `metadata[...]` on a checkout, as Stripe hands it back. */
function metadataOf(body: URLSearchParams): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of body) {
    const name = /^metadata\[([^\]]+)\]$/.exec(key);
    if (name) out[name[1]] = value;
  }
  return out;
}

/** Stripe takes the payment for an opened checkout, and returns it as the thanks page reads it. */
function stripePays(id: string, email: string): Record<string, unknown> {
  const made = opened.find((entry) => entry.id === id);
  if (!made) throw new Error(`no checkout ${id}`);
  const total = Number(made.body.get("line_items[0][price_data][unit_amount]"));
  const session = {
    id,
    object: "checkout.session",
    status: "complete",
    payment_status: "paid",
    mode: made.body.get("mode"),
    currency: made.body.get("line_items[0][price_data][currency]"),
    amount_subtotal: total,
    amount_total: total,
    total_details: { amount_discount: 0, amount_shipping: 0, amount_tax: 0 },
    created: Math.floor(Date.now() / 1000),
    customer_details: { email },
    metadata: metadataOf(made.body),
    payment_intent: `pi_test_journeyaff${id.slice(-6)}`,
  };
  sessions.set(id, session);
  return session;
}

async function main(): Promise<void> {
  redis.clear();
  process.env.STRIPE_SECRET_KEY = "sk_test_journey_affiliate_only";
  process.env.RESEND_API_KEY = "re_test_a_stand_in_key_for_tests_only";

  part("1. The creator's program");
  await claimHandle(OWNER, HANDLE, "Loom Studio", "");
  await ensureStatsId(OWNER);
  await setStripeAccount(OWNER, ACCOUNT, true);
  await setSubscription(OWNER, { customerId: "cus_LoomAff0001", subscriptionId: "sub_LoomAff0001", active: true, period: paidPeriod() });
  const made = await addProduct(OWNER, "Weaving Course", "", "100", null);
  if (!made.ok) throw new Error("no product");
  const product = made.product.id;
  await setProductLink(OWNER, product, "https://example.com/course");
  const set = await setAffiliateSetting(OWNER, { enabled: true, percent: 30, days: 30, rule: "last", rates: {}, payday: 0, hold: 0 } as Parameters<typeof setAffiliateSetting>[1]);
  is("the program is on, at 30%, with no wait", set.ok ? [set.store.affiliates.enabled, set.store.affiliates.percent, set.store.affiliates.hold] : null, [true, 30, 0]);
  const store = async () => (await storeForEmail(OWNER))!;

  part("2. Somebody joins and is approved");
  const asked = await requestAffiliateLink({ store: await store(), email: AFFILIATE, note: "I teach weaving on video.", ip: "203.0.113.9", origin: "https://marktmorgen.com" });
  is("their link is emailed to them", [asked, emails.filter((email) => email.to.includes(AFFILIATE)).length], ["sent", 1]);
  const token = /token=([0-9a-f]{64})/.exec(emails.find((email) => email.to.includes(AFFILIATE))?.text ?? "")?.[1] ?? "";
  const joined = await openAffiliateLink(await store(), token);
  if (!joined.ok) throw new Error(`the link did not open: ${joined.reason}`);
  is("opening it makes them, waiting for the creator", [joined.created, joined.affiliate.email, joined.affiliate.status], [true, AFFILIATE, "pending"]);
  const approved = await decide(await store(), joined.affiliate.id, "approve");
  is("the creator approves them", approved?.status, "approved");
  const code = approved?.code ?? "";
  is("they have a code to share", /^[a-z0-9]{3,20}$/.test(code), true);

  const buy = async (cookie = "") => {
    const form = new FormData();
    form.set("handle", HANDLE);
    form.set("product", product);
    const before = opened.length;
    const response = await checkoutRoute(
      new NextRequest("https://marktmorgen.com/api/store/checkout", { method: "POST", body: withConsent(form), headers: { host: "marktmorgen.com", ...(cookie ? { cookie } : {}) } }),
    );
    const where = new URL(response.headers.get("location") ?? "https://nowhere.invalid/");
    return { stripe: where.hostname === "checkout.stripe.com", made: opened.slice(before) };
  };
  const clicked = `${viaCookieName(HANDLE)}=${viaCookieValue(undefined, code, Date.now() / 1000)}`;
  const owed = async () => {
    const row = (await readBook(await store())).rows.find((entry) => entry.affiliate.email === AFFILIATE);
    return row ? { sales: row.sales, earned: row.earned, paid: row.paid, payable: row.payable } : null;
  };

  part("3. A buyer follows the link and pays");
  const first = await buy(clicked);
  is("sent to Stripe, one checkout on the creator's account", [first.stripe, first.made.length, first.made[0]?.account], [true, 1, ACCOUNT]);
  const meta = metadataOf(first.made[0].body);
  is("the checkout names the affiliate and their rate", [meta.via, meta.via_rate], [joined.affiliate.id, "30"]);
  is("the buyer pays the full $100: the commission never comes off their price", first.made[0].body.get("line_items[0][price_data][unit_amount]"), "10000");
  const paid = stripePays(first.made[0].id, "weaver@example.com");

  part("4. The sale is written down for them");
  is("before it is noted, nothing is owed", (await owed())?.earned ?? 0, 0);
  await noteSession(await store(), paid as Parameters<typeof noteSession>[1]);
  is("$30 earned and payable today", await owed(), { sales: 1, earned: 3000, paid: 0, payable: 3000 });
  await noteSession(await store(), paid as Parameters<typeof noteSession>[1]);
  is("written again, nothing changes", await owed(), { sales: 1, earned: 3000, paid: 0, payable: 3000 });

  part("5. A buyer with no click");
  const direct = await buy();
  is("the checkout names nobody", metadataOf(direct.made[0].body).via, undefined);
  await noteSession(await store(), stripePays(direct.made[0].id, "direct@example.com") as Parameters<typeof noteSession>[1]);
  is("and earns nobody anything", await owed(), { sales: 1, earned: 3000, paid: 0, payable: 3000 });

  part("6. A second sale through the link, refunded before payday");
  const second = await buy(clicked);
  const refunded = stripePays(second.made[0].id, "changed-mind@example.com");
  await noteSession(await store(), refunded as Parameters<typeof noteSession>[1]);
  is("written down, it earns $30 more", await owed(), { sales: 2, earned: 6000, paid: 0, payable: 6000 });
  refunds.push({ object: "refund", id: "re_test_journeyaff0001", status: "succeeded", amount: 10000, currency: "usd", payment_intent: refunded.payment_intent, created: Math.floor(Date.now() / 1000) });
  is("refunded in full at Stripe: it earns nothing, and the book says $30 again", await owed(), { sales: 1, earned: 3000, paid: 0, payable: 3000 });

  part("7. The creator's PayPal pays them");
  is("the creator's own PayPal app is connected", (await connectPayPal(await store(), CLIENT, SECRET)).ok, true);
  const sent = await payWithPayPal(await store());
  const items = (batches[0]?.body.items ?? []) as { amount: { value: string; currency: string }; receiver: string }[];
  is("one batch, one item: $30.00 to the affiliate's address", [batches.length, items.map((item) => [item.amount.value, item.amount.currency, item.receiver])], [1, [["30.00", "USD", AFFILIATE]]]);
  is("sent under PayPal's own idempotency key", Boolean(batches[0]?.requestId), true);
  is("the press says it went", (sent as { ok?: unknown }).ok, true);
  await payWithPayPal(await store());
  is("pressed again while it is on its way: nobody is sent twice", batches.length, 1);
  itemStatus = "SUCCESS";
  is("PayPal says it succeeded: written as paid, once", (await settlePayPal(await store())).paid, 1);
  is("the book: $30 paid, nothing more owed", await owed(), { sales: 1, earned: 3000, paid: 3000, payable: 0 });
  await payWithPayPal(await store());
  is("and the next press sends nothing", batches.length, 1);

  done();
}

void main();
