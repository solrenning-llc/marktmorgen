/**
 * Money journey, end to end: a gift, from the buyer's checkout to the
 * recipient's library and back out of it after a refund (C2-159 item 4,
 * part 2). tests/gifts.test.ts checks each piece on its own, calling
 * startGift, createCheckout and deliverGift directly; this one walks the
 * whole journey through the doors a buyer and the jobs really use, with
 * only Stripe and the email sender simulated:
 *
 *   1. the buyer fills in the gift box on a $49 course and pays through the
 *      real checkout route (POST /api/store/checkout): one plain payment on
 *      the creator's account, marked as a gift, with nothing added;
 *   2. Stripe takes the $49 and the buyer never comes back to the thanks
 *      page; read as it would be there, the order hands the buyer nothing;
 *   3. the five-minute job (sweepCheckouts) finds the paid checkout and
 *      delivers the gift: one email to the recipient with the way in, one
 *      receipt to the buyer for the $49, and the course is on the
 *      recipient's list as a gift from the buyer; run again, nothing more;
 *   4. the buyer is refunded in full at Stripe: the next run takes the gift
 *      back from the recipient, once.
 *
 * Each step reads what the one before wrote, so a break anywhere fails the
 * journey. Synthetic data only: no real Stripe, email or Redis.
 */
import { NextRequest } from "next/server";
import { POST as checkoutRoute } from "@/app/api/store/checkout/route";
import { purchasesFor } from "@/lib/buyer-orders";
import { sweepCheckouts } from "@/lib/checkout-sweep";
import { importedFor } from "@/lib/imported-purchases";
import { readOrder } from "@/lib/store-checkout";
import { addProduct, claimHandle, ensureStatsId, setProductLink, setStripeAccount, setSubscription, storeForEmail } from "@/lib/store";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";
import { paidPeriod } from "./billing-period-fixture";
import { withConsent } from "./digital-consent-fixture";

const OWNER = "bakery@example.com";
const HANDLE = "crumbandco";
const ACCOUNT = "acct_1TestCrumb00001";
const BUYER = "ana@example.com";
const FRIEND = "friend@example.com";

const opened: { id: string; body: URLSearchParams; account: string | null }[] = [];
const sessions = new Map<string, Record<string, unknown>>();
const refunds: Record<string, unknown>[] = [];
const emails: { to: string[]; subject: string; text: string }[] = [];
const answer = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
/** As Stripe answers: the payment is only its id unless the request expanded it. */
const asAsked = (session: Record<string, unknown>, url: URL) => {
  const pi = session.payment_intent as { id?: string } | string | undefined;
  const expanded = url.searchParams.getAll("expand[]").some((field) => field.startsWith("payment_intent"));
  return pi && typeof pi === "object" && !expanded ? { ...session, payment_intent: pi.id } : session;
};

globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const url = new URL(String(input));
  const method = init?.method ?? "GET";
  if (url.hostname === "api.resend.com") {
    emails.push(JSON.parse(String(init?.body)));
    return answer({ id: `email_${emails.length}` });
  }
  if (url.hostname !== "api.stripe.com") return answer({}, 404);
  if (url.pathname === "/v1/checkout/sessions" && method === "POST") {
    const id = `cs_test_journeygift${String(opened.length + 1).padStart(6, "0")}`;
    opened.push({ id, body: new URLSearchParams(String(init?.body)), account: new Headers(init?.headers).get("Stripe-Account") });
    sessions.set(id, { id, object: "checkout.session", status: "open", payment_status: "unpaid", created: Math.floor(Date.now() / 1000) });
    return answer({ id, url: `https://checkout.stripe.com/c/pay/${id}` });
  }
  if (url.pathname === "/v1/checkout/sessions" && method === "GET") {
    // The day's checkouts, as the job walks them: the status it asked for.
    const status = url.searchParams.get("status");
    return answer({ object: "list", data: [...sessions.values()].filter((session) => !status || session.status === status).map((session) => asAsked(session, url)), has_more: false });
  }
  const one = /^\/v1\/checkout\/sessions\/([^/]+)$/.exec(url.pathname);
  if (one && method === "GET") {
    const found = sessions.get(decodeURIComponent(one[1]));
    return found ? answer(asAsked(found, url)) : answer({ error: { message: "No such checkout.session" } }, 404);
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

async function main(): Promise<void> {
  redis.clear();
  process.env.STRIPE_SECRET_KEY = "sk_test_journey_gift_only";
  process.env.RESEND_API_KEY = "re_test_a_stand_in_key_for_tests_only";

  await claimHandle(OWNER, HANDLE, "Crumb and Co", "");
  await ensureStatsId(OWNER);
  await setStripeAccount(OWNER, ACCOUNT, true);
  await setSubscription(OWNER, { customerId: "cus_Crumb000001", subscriptionId: "sub_Crumb000001", active: true, period: paidPeriod() });
  const made = await addProduct(OWNER, "Sourdough Course", "", "49", null);
  if (!made.ok) throw new Error("no product");
  const course = made.product.id;
  await setProductLink(OWNER, course, "https://example.com/sourdough");
  const store = async () => (await storeForEmail(OWNER))!;

  part("1. The buyer gives the course");
  const form = new FormData();
  form.set("handle", HANDLE);
  form.set("product", course);
  form.set("gift_to", "Friend@Example.com");
  form.set("gift_from", "Ana");
  form.set("gift_message", "Happy birthday! Bake something good.");
  const bought = await checkoutRoute(new NextRequest("https://marktmorgen.com/api/store/checkout", { method: "POST", body: withConsent(form), headers: { host: "marktmorgen.com" } }));
  is("sent to Stripe, one checkout on the creator's account", [new URL(bought.headers.get("location") ?? "https://x/").hostname, opened.length, opened[0]?.account], ["checkout.stripe.com", 1, ACCOUNT]);
  const checkout = opened[0];
  const meta = metadataOf(checkout.body);
  is("one plain payment of $49, marked as a gift", [checkout.body.get("mode"), checkout.body.get("line_items[0][price_data][unit_amount]"), /^gft_[0-9a-f]{24}$/.test(meta.gift ?? "")], ["payment", "4900", true]);
  is("nothing added and no offer after it", [checkout.body.get("line_items[1][quantity]"), meta.upsell_key], [null, undefined]);

  part("2. Paid, and the buyer never comes back");
  const now = Math.floor(Date.now() / 1000);
  sessions.set(checkout.id, {
    id: checkout.id, object: "checkout.session", status: "complete", payment_status: "paid", mode: "payment", currency: "usd",
    amount_subtotal: 4900, amount_total: 4900, total_details: { amount_discount: 0, amount_shipping: 0, amount_tax: 0 },
    created: now, customer_details: { email: BUYER }, metadata: meta,
    payment_intent: { id: "pi_test_journeygift0001", object: "payment_intent", status: "succeeded", latest_charge: { id: "ch_test_journeygift0001", object: "charge", amount: 4900, amount_refunded: 0, refunded: false, disputed: false }, payment_method: { type: "card" } },
  });
  const order = await readOrder(await store(), checkout.id);
  is("read as the thanks page reads it: paid, a gift, for $49", order.state === "paid" ? [order.gift, order.amount] : order.state, [meta.gift, 4900]);
  is("before the job runs, nobody has it and nobody was emailed", [(await importedFor(await store(), FRIEND)).length, emails.length], [0, 0]);

  part("3. The five-minute job delivers it");
  process.env.STRIPE_SECRET_KEY = "sk_test_journey_gift_only";
  await sweepCheckouts(Date.now() + 20_000);
  const toFriend = emails.filter((email) => email.to.includes(FRIEND));
  const toBuyer = emails.filter((email) => email.to.includes(BUYER));
  is("one email to the recipient: who it is from, what it is, the message and the way in", [
    toFriend.length,
    toFriend[0]?.subject,
    Boolean(toFriend[0]?.text.includes("Happy birthday! Bake something good.") && toFriend[0]?.text.includes(`/@${HANDLE}/orders?token=`)),
  ], [1, "Ana sent you a gift: Sourdough Course", true]);
  is("one receipt to the buyer, saying who it went to and the $49 paid", [toBuyer.length, Boolean(toBuyer[0]?.text.includes(`For: ${FRIEND}`) && toBuyer[0]?.text.includes("$49"))], [1, true]);
  is("it is the recipient's", (await importedFor(await store(), FRIEND)).map((purchase) => purchase.productId), [course]);
  const listed = await purchasesFor({ ...(await store()), stripeAccountId: null }, FRIEND);
  is("on the recipient's list, as a gift from Ana, opening the course", listed.map((purchase) => [purchase.title, purchase.giftFrom, purchase.main?.link]), [["Sourdough Course", "Ana", "https://example.com/sourdough"]]);
  await sweepCheckouts(Date.now() + 20_000);
  is("run again, no email and no second copy", [emails.length, (await importedFor(await store(), FRIEND)).length], [2, 1]);

  part("4. Refunded in full");
  refunds.push({ object: "refund", id: "re_test_journeygift0001", status: "succeeded", amount: 4900, currency: "usd", created: Math.floor(Date.now() / 1000), payment_intent: "pi_test_journeygift0001", charge: { id: "ch_test_journeygift0001", refunded: true, amount: 4900, amount_refunded: 4900 } });
  await sweepCheckouts(Date.now() + 20_000);
  is("the next run takes it back from the recipient", (await importedFor(await store(), FRIEND)).length, 0);
  is("and their list no longer opens it", (await purchasesFor({ ...(await store()), stripeAccountId: null }, FRIEND)).length, 0);
  is("nobody is emailed about it again", emails.length, 2);

  done();
}

void main();
