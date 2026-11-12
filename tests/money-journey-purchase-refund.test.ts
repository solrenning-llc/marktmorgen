/**
 * The journey that brings money in, end to end, through the real code (C1-20261112-1459-C2-159, item 4): a creator
 * signs up and connects Stripe, a product is on the store front, a buyer opens the real checkout route, pays, is
 * confirmed with one receipt, gets what was bought, and the creator refunds the payment in their own Stripe. Each
 * step is the code the site runs; only Stripe and the email sender are stood in for, with fictitious data. A step
 * that breaks fails here:
 *
 *   - sign-up: the store, its stats id, its connected Stripe account and its paid plan;
 *   - store front: the product is listed at its price;
 *   - checkout (app/api/store/checkout): one Stripe session on the creator's own account, at the product's price,
 *     in the store's currency, sent back as a redirect to Stripe's page; nothing is confirmed before paying;
 *   - paid: readOrder says paid and hands over the product's link; confirmPurchase sends one receipt to the buyer,
 *     with the product and the amount, and counts one order; confirming again sends nothing more;
 *   - refunded on Stripe: readOrder says refunded, so the link is no longer handed over, and no second receipt goes.
 */
import { NextRequest } from "next/server";
import { addProduct, claimHandle, ensureStatsId, setProductLink, setStripeAccount, setSubscription, storeForEmail } from "@/lib/store";
import { readListing } from "@/lib/catalog";
import { readOrder } from "@/lib/store-checkout";
import { confirmPurchase } from "@/lib/purchase-email";
import { storeOrdersThisMonth } from "@/lib/orders";
import { POST as checkoutRoute } from "@/app/api/store/checkout/route";
import { withConsent } from "./digital-consent-fixture";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";
import { paidPeriod } from "./billing-period-fixture";

process.env.STRIPE_SECRET_KEY = "sk_test_money_journey_only_a_stand_in";
process.env.RESEND_API_KEY = "re_test_a_stand_in_key_for_tests_only";

const ACCOUNT = "acct_1TestMoneyJourney";
const BUYER = "buyer.journey@example.com";
type Session = Record<string, unknown> & { id: string; metadata: Record<string, string> };
const sessions = new Map<string, Session>();
const opened: { body: URLSearchParams; account: string | null }[] = [];
const mails: { to: string; subject: string; text: string }[] = [];

globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const url = new URL(String(input instanceof Request ? input.url : input));
  const answer = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
  if (url.hostname === "api.resend.com") {
    const body = JSON.parse(String(init?.body)) as { to: string[]; subject: string; text: string };
    mails.push({ to: body.to[0], subject: body.subject, text: body.text });
    return answer({ id: `email_${mails.length}` });
  }
  if (url.hostname !== "api.stripe.com") return answer({ error: "unexpected" }, 404);
  const path = url.pathname.replace(/^\/v1/, "");
  const method = init?.method ?? "GET";
  if (path === "/checkout/sessions" && method === "POST") {
    const body = new URLSearchParams(String(init?.body));
    opened.push({ body, account: new Headers(init?.headers).get("stripe-account") });
    const id = `cs_test_${String(opened.length).padStart(24, "j")}`;
    const metadata: Record<string, string> = {};
    for (const [key, value] of body) {
      const m = /^metadata\[(.+)\]$/.exec(key);
      if (m) metadata[m[1]] = value;
    }
    const session: Session = { id, object: "checkout.session", status: "open", payment_status: "unpaid", mode: body.get("mode") ?? "payment", url: `https://checkout.stripe.com/c/pay/${id}`, metadata, created: Math.floor(Date.now() / 1000), currency: body.get("currency") ?? "usd" };
    sessions.set(id, session);
    return answer(session);
  }
  const one = /^\/checkout\/sessions\/(cs_test_[A-Za-z0-9]+)$/.exec(path)?.[1];
  if (one && method === "GET") {
    const found = sessions.get(one);
    return found ? answer(found) : answer({ error: { code: "resource_missing", message: "No such checkout" } }, 404);
  }
  if (/^\/checkout\/sessions\/cs_test_[A-Za-z0-9]+\/line_items$/.test(path)) {
    const found = sessions.get(path.split("/")[3]);
    return answer({ object: "list", data: found ? [{ id: "li_journey", object: "item", quantity: 1, amount_total: found.amount_total, currency: found.currency, description: "Sourdough Guide" }] : [], has_more: false });
  }
  return answer({ object: "list", data: [], has_more: false });
}) as typeof fetch;

/** The buyer pays on Stripe's page: the session completes with a charge for its amount, as Stripe returns it. */
function pay(id: string, cents: number): void {
  const session = sessions.get(id)!;
  sessions.set(id, {
    ...session,
    status: "complete",
    payment_status: "paid",
    amount_total: cents,
    amount_subtotal: cents,
    customer_details: { email: BUYER, name: "Jo Buyer" },
    payment_intent: { id: "pi_test_moneyjourney01", object: "payment_intent", status: "succeeded", amount: cents, amount_received: cents, latest_charge: { id: "ch_test_moneyjourney01", object: "charge", amount: cents, amount_refunded: 0, refunded: false, paid: true, status: "succeeded", disputed: false } },
  });
}

/** The creator refunds the whole payment from their own Stripe dashboard. */
function refundInStripe(id: string): void {
  const session = sessions.get(id)!;
  const pi = session.payment_intent as { latest_charge: Record<string, unknown> } & Record<string, unknown>;
  sessions.set(id, { ...session, payment_intent: { ...pi, latest_charge: { ...pi.latest_charge, amount_refunded: pi.latest_charge.amount, refunded: true } } });
}

async function main(): Promise<void> {
  redis.clear();

  part("Sign-up: the creator's store, connected to their own Stripe, on a paid plan");
  const owner = "creator.journey@example.com";
  await claimHandle(owner, "journeybakery", "Journey Bakery", "");
  await ensureStatsId(owner);
  await setStripeAccount(owner, ACCOUNT, true);
  await setSubscription(owner, { customerId: "cus_TestJourney01", subscriptionId: "sub_TestJourney01", active: true, period: paidPeriod() });
  const added = await addProduct(owner, "Sourdough Guide", "", "29", null);
  if (!added.ok) throw new Error("no product");
  await setProductLink(owner, added.product.id, "https://example.com/sourdough-guide");
  const store = (await storeForEmail(owner))!;
  is("the store is kept with its stats id and its Stripe account", [store.handle, Boolean(store.statsId), store.stripeAccountId], ["journeybakery", true, ACCOUNT]);

  part("Store front: the product is listed at its price");
  const listing = await readListing(store, added.product.id);
  is("listed, $29.00, with the link it hands over", [listing?.title, listing?.priceCents, listing?.link], ["Sourdough Guide", 2900, "https://example.com/sourdough-guide"]);

  part("Checkout: the real route opens one Stripe session on the creator's account");
  const form = withConsent(new FormData());
  form.set("handle", "journeybakery");
  form.set("product", added.product.id);
  const response = await checkoutRoute(new NextRequest("https://marktmorgen.com/api/store/checkout", { method: "POST", body: form, headers: { host: "marktmorgen.com" } }));
  const sent = opened[0];
  is("one session, on the creator's own Stripe account", [opened.length, sent?.account], [1, ACCOUNT]);
  is("at the product's price, in the store's currency", [sent?.body.get("line_items[0][price_data][unit_amount]"), sent?.body.get("line_items[0][price_data][currency]")], ["2900", "usd"]);
  const id = [...sessions.keys()][0];
  is("the buyer is sent to Stripe's page", [response.status >= 300 && response.status < 400, response.headers.get("location")], [true, `https://checkout.stripe.com/c/pay/${id}`]);
  is("before paying, the order is not paid and nothing is confirmed", [(await readOrder(store, id)).state, await confirmPurchase(store, id), mails.length], ["unpaid", "skip", 0]);

  part("Paid: the product is handed over and one receipt goes");
  pay(id, 2900);
  const paidOrder = await readOrder(store, id);
  is("the order is paid and hands over the product's link", [paidOrder.state, paidOrder.state === "paid" ? paidOrder.product.link : null], ["paid", "https://example.com/sourdough-guide"]);
  const before = await storeOrdersThisMonth(store);
  is("the confirmation is sent", await confirmPurchase(store, id), "sent");
  const receipt = mails.filter((m) => m.to === BUYER);
  is("one receipt, to the buyer, naming the product and the amount paid", [receipt.length, receipt[0]?.text.includes("Sourdough Guide"), /^Paid: \$29$/m.test(receipt[0]?.text ?? "")], [1, true, true]);
  is("and one order is counted for the month", (await storeOrdersThisMonth(store))! - before!, 1);
  is("confirming again sends nothing more", [await confirmPurchase(store, id), mails.filter((m) => m.to === BUYER).length], ["already", 1]);

  part("Refunded in the creator's Stripe: access closes and no second receipt goes");
  refundInStripe(id);
  is("the order reads as refunded, so its link is no longer handed over", (await readOrder(store, id)).state, "refunded");
  is("and no receipt goes again", [await confirmPurchase(store, id), mails.filter((m) => m.to === BUYER).length], ["already", 1]);
  done();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
