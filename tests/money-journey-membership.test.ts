/**
 * Money journey, end to end: a membership, from the first payment through
 * its renewals to its cancellation (C2-159 item 4, part 2). The other tests
 * check each step on its own (tests/membership-past-due-retry.test.ts,
 * tests/purchase-email-paid-line.test.ts, the membership-manage tests); this
 * one walks a member through all of them in order, with the real code at
 * every step and only Stripe and the email sender simulated:
 *
 *   1. a $12 a month club, bought through the real checkout route
 *      (POST /api/store/checkout): one subscription checkout on the
 *      creator's own account, at the price shown, every month;
 *   2. Stripe takes the first $12: readOrder opens the club, and the
 *      confirmation says what was paid, once;
 *   3. the next month's renewal is paid: the club stays open;
 *   4. a renewal fails with another attempt scheduled: still open while
 *      Stripe retries; with no attempt left, it closes; the retry paid, it
 *      opens again;
 *   5. the member asks for their link (POST /api/store/manage): one email,
 *      whose link lists the club at $12 a month, not ending;
 *   6. the member presses Cancel (POST /api/store/manage/cancel): Stripe's
 *      own cancellation page for exactly this membership and customer;
 *      another member's membership, sent from this link, opens nothing;
 *   7. cancelled at the period's end: the list says when it ends, the club
 *      stays open until then, Cancel is not offered twice, and once Stripe
 *      ends it the club closes.
 *
 * Each step reads what the one before wrote, so a break anywhere fails the
 * journey. Synthetic data only: no real Stripe, email or Redis.
 */
import { NextRequest } from "next/server";
import { POST as checkoutRoute } from "@/app/api/store/checkout/route";
import { POST as manageRoute } from "@/app/api/store/manage/route";
import { POST as cancelRoute } from "@/app/api/store/manage/cancel/route";
import { membershipsFor } from "@/lib/membership-manage";
import { confirmPurchase } from "@/lib/purchase-email";
import { readOrder } from "@/lib/store-checkout";
import { addProduct, claimHandle, ensureStatsId, setProductLink, setStripeAccount, setSubscription, storeForEmail } from "@/lib/store";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";
import { paidPeriod } from "./billing-period-fixture";
import { withConsent } from "./digital-consent-fixture";

const OWNER = "garden@example.com";
const HANDLE = "gardenclub";
const ACCOUNT = "acct_1TestGarden001";
const MEMBER = "fern@example.com";
const MONTH = 30 * 86_400;

const opened: { id: string; body: URLSearchParams; account: string | null }[] = [];
const sessions = new Map<string, Record<string, unknown>>();
const subscriptions = new Map<string, Record<string, unknown>>();
const customers: { id: string; email: string }[] = [];
const portals: { body: URLSearchParams; account: string | null }[] = [];
const emails: { to: string[]; subject: string; text: string }[] = [];
const answer = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });

globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const url = new URL(String(input));
  const method = init?.method ?? "GET";
  if (url.hostname === "api.resend.com") {
    emails.push(JSON.parse(String(init?.body)));
    return answer({ id: `email_${emails.length}` });
  }
  if (url.hostname !== "api.stripe.com") return answer({}, 404);
  const account = new Headers(init?.headers).get("Stripe-Account");
  const sent = new URLSearchParams(init?.body ? String(init.body) : "");
  if (url.pathname === "/v1/checkout/sessions" && method === "POST") {
    const id = `cs_test_journeyclub${String(opened.length + 1).padStart(6, "0")}`;
    opened.push({ id, body: sent, account });
    sessions.set(id, { id, object: "checkout.session", status: "open", payment_status: "unpaid" });
    return answer({ id, url: `https://checkout.stripe.com/c/pay/${id}` });
  }
  const one = /^\/v1\/checkout\/sessions\/([^/]+)$/.exec(url.pathname);
  if (one && method === "GET") {
    const found = sessions.get(decodeURIComponent(one[1]));
    if (!found) return answer({ error: { message: "No such checkout.session" } }, 404);
    // Expanded as asked: the subscription as it is now, with its latest invoice.
    const sub = typeof found.subscription === "string" ? subscriptions.get(found.subscription) : null;
    return answer(sub ? { ...found, subscription: sub } : found);
  }
  if (url.pathname === "/v1/customers" && method === "GET") {
    const email = url.searchParams.get("email");
    return answer({ object: "list", data: customers.filter((customer) => customer.email === email).map((customer) => ({ object: "customer", ...customer, created: 1 })), has_more: false });
  }
  if (url.pathname === "/v1/subscriptions" && method === "GET") {
    const customer = url.searchParams.get("customer");
    return answer({ object: "list", data: [...subscriptions.values()].filter((sub) => !customer || sub.customer === customer), has_more: false });
  }
  const subOne = /^\/v1\/subscriptions\/([^/]+)$/.exec(url.pathname);
  if (subOne && method === "GET") {
    const sub = subscriptions.get(decodeURIComponent(subOne[1]));
    return sub ? answer(sub) : answer({ error: { message: "No such subscription" } }, 404);
  }
  if (url.pathname === "/v1/billing_portal/configurations" && method === "POST") return answer({ id: "bpc_1TestGarden0001", object: "billing_portal.configuration" });
  if (url.pathname === "/v1/billing_portal/sessions" && method === "POST") {
    portals.push({ body: sent, account });
    return answer({ id: `bps_test_${portals.length}`, url: `https://billing.stripe.com/p/session/test_${portals.length}` });
  }
  return answer({ object: "list", data: [], has_more: false });
}) as typeof fetch;

/** What was sent as `metadata[...]` on a checkout, as Stripe hands it back. */
function metadataOf(body: URLSearchParams, prefix = "metadata"): Record<string, string> {
  const out: Record<string, string> = {};
  const pattern = new RegExp(`^${prefix.replace(/[[\]]/g, "\\$&")}\\[([^\\]]+)\\]$`);
  for (const [key, value] of body) {
    const name = pattern.exec(key);
    if (name) out[name[1]] = value;
  }
  return out;
}

async function main(): Promise<void> {
  redis.clear();
  process.env.STRIPE_SECRET_KEY = "sk_test_journey_club_only";
  process.env.RESEND_API_KEY = "re_test_a_stand_in_key_for_tests_only";

  await claimHandle(OWNER, HANDLE, "Garden Club", "");
  await ensureStatsId(OWNER);
  await setStripeAccount(OWNER, ACCOUNT, true);
  await setSubscription(OWNER, { customerId: "cus_Garden00001", subscriptionId: "sub_Garden00001", active: true, period: paidPeriod() });
  const made = await addProduct(OWNER, "Seed Club", "", "12", { interval: "month", trialDays: 0, payments: 0 } as Parameters<typeof addProduct>[4]);
  if (!made.ok) throw new Error("no membership");
  const club = made.product.id;
  await setProductLink(OWNER, club, "https://example.com/seed-club");
  const store = async () => (await storeForEmail(OWNER))!;
  const post = (path: string, form: FormData) =>
    new NextRequest(`https://marktmorgen.com${path}`, { method: "POST", body: form, headers: { host: "marktmorgen.com", origin: "https://marktmorgen.com", "x-forwarded-for": "203.0.113.20" } });

  part("1. The member buys the club");
  const form = new FormData();
  form.set("handle", HANDLE);
  form.set("product", club);
  const bought = await checkoutRoute(post("/api/store/checkout", withConsent(form)));
  is("sent to Stripe, one checkout", [new URL(bought.headers.get("location") ?? "https://x/").hostname, opened.length], ["checkout.stripe.com", 1]);
  const checkout = opened[0];
  is("on the creator's own account, as a subscription", [checkout.account, checkout.body.get("mode")], [ACCOUNT, "subscription"]);
  is("$12 every month, in the store's currency", [checkout.body.get("line_items[0][price_data][unit_amount]"), checkout.body.get("line_items[0][price_data][recurring][interval]"), checkout.body.get("line_items[0][price_data][currency]")], ["1200", "month", "usd"]);
  const subMeta = metadataOf(checkout.body, "subscription_data[metadata]");
  is("the membership itself names the store and the club", [subMeta.store, subMeta.product], [HANDLE, club]);

  part("2. Stripe takes the first $12");
  const now = Math.floor(Date.now() / 1000);
  const subId = "sub_1TestFernClub01";
  customers.push({ id: "cus_1TestFern0001", email: MEMBER });
  const period = (end: number) => ({ object: "list", data: [{ id: "si_1TestFern0001", current_period_end: end, price: { unit_amount: 1200, currency: "usd", recurring: { interval: "month", interval_count: 1 } } }], has_more: false });
  const setSub = (over: Record<string, unknown>) =>
    subscriptions.set(subId, {
      id: subId, object: "subscription", customer: "cus_1TestFern0001", status: "active", currency: "usd", created: now,
      cancel_at_period_end: false, cancel_at: null, metadata: subMeta, items: period(now + MONTH),
      latest_invoice: { id: "in_1TestFern0001", object: "invoice", status: "paid", next_payment_attempt: null },
      ...(subscriptions.get(subId) ?? {}), ...over,
    });
  setSub({});
  sessions.set(checkout.id, {
    id: checkout.id, object: "checkout.session", status: "complete", payment_status: "paid", mode: "subscription", currency: "usd",
    amount_subtotal: 1200, amount_total: 1200, total_details: { amount_discount: 0, amount_shipping: 0, amount_tax: 0 },
    created: now, customer: "cus_1TestFern0001", customer_details: { email: MEMBER }, metadata: metadataOf(checkout.body), subscription: subId, invoice: "in_1TestFern0001",
  });
  const access = async () => {
    const order = await readOrder(await store(), checkout.id);
    return order.state === "paid" ? { membership: order.membership, link: order.membership === "live" ? order.link : null } : { membership: order.state, link: null };
  };
  is("the club is open, with its link", await access(), { membership: "live", link: "https://example.com/seed-club" });
  is("the confirmation is sent", await confirmPurchase(await store(), checkout.id), "sent");
  const receipt = emails.filter((email) => email.to.includes(MEMBER));
  is("one email to the member, for the Seed Club", [receipt.length, receipt[0]?.text.includes("Seed Club")], [1, true]);
  is("it says what was paid, and that it renews", (receipt[0]?.text ?? "").split("\n").find((line) => line.startsWith("Paid:")), "Paid: $12 a month");
  is("a second try sends nothing more", await confirmPurchase(await store(), checkout.id), "already");

  part("3. The next month's renewal is paid");
  setSub({ items: period(now + 2 * MONTH), latest_invoice: { id: "in_1TestFern0002", object: "invoice", status: "paid", next_payment_attempt: null } });
  is("the club stays open", (await access()).membership, "live");

  part("4. A renewal that fails");
  setSub({ status: "past_due", latest_invoice: { id: "in_1TestFern0003", object: "invoice", status: "open", next_payment_attempt: now + 3 * 86_400 } });
  is("open while Stripe has another attempt scheduled", (await access()).membership, "live");
  setSub({ latest_invoice: { id: "in_1TestFern0003", object: "invoice", status: "open", next_payment_attempt: null } });
  is("closed once no attempt is left", await access(), { membership: "ended", link: null });
  setSub({ status: "active", items: period(now + 3 * MONTH), latest_invoice: { id: "in_1TestFern0003", object: "invoice", status: "paid", next_payment_attempt: null } });
  is("the retry paid: open again", (await access()).membership, "live");

  part("5. The member asks for their link");
  const ask = new FormData();
  ask.set("handle", HANDLE);
  ask.set("email", MEMBER);
  const asked = await manageRoute(post("/api/store/manage", ask));
  is("the page says the link was sent", asked.headers.get("location"), `https://marktmorgen.com/@${HANDLE}/manage?status=sent`);
  const linkEmail = emails.filter((email) => email.to.includes(MEMBER)).at(-1);
  const token = /manage\?token=([0-9a-f]{64})/.exec(linkEmail?.text ?? "")?.[1] ?? "";
  is("one email with the member's own link", [emails.filter((email) => email.to.includes(MEMBER)).length, token.length], [2, 64]);
  const listed = await membershipsFor(await store(), token);
  is("the link lists the club, $12 a month, not ending", listed?.map((m) => [m.id, m.title, m.amount, m.interval, m.endsAt]), [[subId, "Seed Club", 1200, "month", null]]);

  part("6. The member presses Cancel");
  const press = async (subscription: string) => {
    const f = new FormData();
    f.set("handle", HANDLE);
    f.set("token", token);
    f.set("subscription", subscription);
    return (await cancelRoute(post("/api/store/manage/cancel", f))).headers.get("location") ?? "";
  };
  // Another member of the same club, on the same account.
  subscriptions.set("sub_1TestSomeoneElse1", { ...subscriptions.get(subId), id: "sub_1TestSomeoneElse1", customer: "cus_1TestOther0001" });
  const notTheirs = await press("sub_1TestSomeoneElse1");
  is("another member's membership, sent from this link, opens nothing", [notTheirs.includes("status=error"), portals.length], [true, 0]);
  subscriptions.delete("sub_1TestSomeoneElse1");
  const cancelPage = await press(subId);
  is("sent to Stripe's own cancellation page", cancelPage, "https://billing.stripe.com/p/session/test_1");
  const portal = portals[0];
  is(
    "for exactly this member and this membership, on the creator's account",
    [portal?.account, portal?.body.get("customer"), portal?.body.get("flow_data[type]"), portal?.body.get("flow_data[subscription_cancel][subscription]")],
    [ACCOUNT, "cus_1TestFern0001", "subscription_cancel", subId],
  );

  part("7. Cancelled at the end of the period");
  const end = now + 3 * MONTH;
  setSub({ cancel_at_period_end: true });
  is("the list says when it ends", (await membershipsFor(await store(), token))?.map((m) => m.endsAt), [end]);
  is("the club stays open until then", (await access()).membership, "live");
  const again = await press(subId);
  is("Cancel is not offered twice", [again.includes("status=error"), portals.length], [true, 1]);
  setSub({ status: "canceled", ended_at: end });
  is("Stripe ended it: the club closes", await access(), { membership: "ended", link: null });
  is("and the link lists nothing left to manage", (await membershipsFor(await store(), token))?.length, 0);

  done();
}

void main();
