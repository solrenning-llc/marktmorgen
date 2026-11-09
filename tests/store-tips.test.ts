/**
 * "Support my work" (lib/store-tips.ts, lib/store-tip-checkout.ts; added 9
 * October 2026). Checked: the amounts are held to a range in the store's
 * currency; the box shows only on a store that can take money; the checkout
 * is one plain payment on the creator's own account with nothing of a sale
 * on it, marked so the sales list and the sweep know it for what it is; and
 * the page a supporter comes back to thanks them only for a gift Stripe says
 * was paid, to this store.
 */
import { claimHandle, ensureStatsId, setLanguage, setStripeAccount, setSubscription, setTips, storeForEmail } from "@/lib/store";
import { MAX_TIP_AMOUNTS, parseTips, readTipAmount, tipAmounts, tipBounds, tipInRange, usualTipAmounts } from "@/lib/store-tips";
import { TIP_TITLE, createTipCheckout, readTip, tipsOpen } from "@/lib/store-tip-checkout";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";
import { paidPeriod } from "./billing-period-fixture";

const checkouts: URLSearchParams[] = [];
const checkoutHeaders: Headers[] = [];
let session: Record<string, unknown> = {};
globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const url = new URL(String(input));
  const path = url.pathname.replace(/^\/v1/, "");
  const method = init?.method ?? "GET";
  const answer = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
  if (path === "/checkout/sessions" && method === "POST") {
    checkouts.push(new URLSearchParams(String(init?.body)));
    checkoutHeaders.push(new Headers(init?.headers));
    return answer({ id: `cs_test_${"t".repeat(24)}`, url: "https://checkout.stripe.com/c/pay/test" });
  }
  if (path.startsWith("/checkout/sessions/") && method === "GET") return answer(session);
  return answer({ object: "list", data: [], has_more: false });
}) as typeof fetch;

async function main(): Promise<void> {
  redis.clear();
  process.env.STRIPE_SECRET_KEY = "sk_test_tips_only_a_stand_in";

  part("The amounts");
  is("from the least a product may cost to a tenth of the most", [tipBounds("usd"), tipBounds("jpy")], [{ min: 100, max: 50_000 }, { min: 100, max: 75_000 }]);
  is("three, five and ten times the least until the creator chooses", [usualTipAmounts("usd"), usualTipAmounts("sek")], [[300, 500, 1_000], [3_000, 5_000, 10_000]]);
  is("the creator's, in range and in rising order", tipAmounts({ on: true, heading: "", line: "", amounts: [2_000, 50, 700] }, "usd"), [700, 2_000]);
  is("and the usual three when none is left", tipAmounts({ on: true, heading: "", line: "", amounts: [10] }, "usd"), [300, 500, 1_000]);
  is("typed the plain way or the European way", [readTipAmount("5", "usd"), readTipAmount("5.50", "usd"), readTipAmount("5,50", "eur"), readTipAmount("2500", "jpy")], [500, 550, 550, 2_500]);
  is("never with a sign, a separator, too little or too much", [readTipAmount("$5", "usd"), readTipAmount("1,000", "usd"), readTipAmount("0.50", "usd"), readTipAmount("501", "usd"), readTipAmount("", "usd")], [null, null, null, null, null]);
  is("in range means a whole number of cents inside the bounds", [tipInRange(100, "usd"), tipInRange(99, "usd"), tipInRange(100.5, "usd")], [true, false, false]);
  is("a kept setting, made safe", parseTips({ on: true, heading: "  Buy me   a coffee ", line: 5, amounts: [300, -1, "x", 500, 900, 1200] }), { on: true, heading: "Buy me a coffee", line: "", amounts: [300, 500, 900] });
  is("at most three", MAX_TIP_AMOUNTS, 3);

  part("Only on a store that can take money");
  const owner = "tips@example.com";
  await claimHandle(owner, "tipshop", "Tip Shop", "");
  await ensureStatsId(owner);
  await setTips(owner, { on: true, heading: "", line: "", amounts: [] });
  is("switched on, but no Stripe yet: not shown", tipsOpen((await storeForEmail(owner))!), false);
  await setStripeAccount(owner, "acct_1TestTips000001", true);
  await setSubscription(owner, { customerId: "cus_Tips00001", subscriptionId: "sub_Tips00001", active: true, period: paidPeriod() });
  is("with a till that works: shown", tipsOpen((await storeForEmail(owner))!), true);

  part("The checkout");
  await setLanguage(owner, "de");
  const store = (await storeForEmail(owner))!;
  const opened = await createTipCheckout(store, "https://marktmorgen.com", 500);
  const sent = checkouts[0];
  is("goes to Stripe", opened.url, "https://checkout.stripe.com/c/pay/test");
  is("support is charged directly on this creator's connected account", checkoutHeaders[0].get("Stripe-Account"), store.stripeAccountId);
  is("support uses the platform test key to act on that connected account", checkoutHeaders[0].get("Authorization"), "Bearer sk_test_tips_only_a_stand_in");
  is("support never routes a platform charge through a destination or transfer", [...sent.keys()].filter((key) => /transfer_data|on_behalf_of|destination/.test(key)), []);
  is("one payment of the amount chosen, in the store's currency and language", [sent.get("mode"), sent.get("line_items[0][price_data][unit_amount]"), sent.get("line_items[0][price_data][currency]"), sent.get("locale"), sent.get("line_items[0][price_data][product_data][name]")], ["payment", "500", "usd", "de", "Unterstützung für Tip Shop"]);
  is("marked as support, for the list of sales and the sweep", [sent.get("metadata[store]"), sent.get("metadata[kind]"), sent.get("metadata[title]"), sent.get("payment_intent_data[metadata][kind]")], ["tipshop", "tip", TIP_TITLE, "tip"]);
  is("with a box for a message, which may be left empty", [sent.get("custom_fields[0][type]"), sent.get("custom_fields[0][optional]"), sent.get("custom_fields[0][label][custom]")], ["text", "true", "Deine Nachricht"]);
  is("and nothing of a sale: no code box, no discount, no tax, no affiliate", [...sent.keys()].filter((key) => /promotion|discounts|automatic_tax|metadata\[via|metadata\[product/.test(key)), []);
  is("back to a thank-you page of the store's", sent.get("success_url"), "https://marktmorgen.com/@tipshop/tip?session_id={CHECKOUT_SESSION_ID}");
  let refused = "";
  await createTipCheckout(store, "https://marktmorgen.com", 50).catch((error: Error) => (refused = error.message));
  is("an amount out of range never reaches Stripe", [refused, checkouts.length], ["An amount out of range", 1]);

  part("The page a supporter comes back to");
  const id = `cs_test_${"t".repeat(24)}`;
  // The paid answer comes last: once Stripe said a gift was paid, the page remembers it for that session.
  session = { id, status: "open", payment_status: "unpaid", amount_total: 500, currency: "usd", metadata: { store: "tipshop", kind: "tip" } };
  is("not paid: nothing confirmed", (await readTip(store, id)).state, "waiting");
  session = { id, status: "complete", payment_status: "paid", amount_total: 900, currency: "usd", metadata: { store: "tipshop", product: "abc" } };
  is("a product's checkout is not a gift", (await readTip(store, id)).state, "waiting");
  session = { id, status: "complete", payment_status: "paid", amount_total: 900, currency: "usd", metadata: { store: "othershop", kind: "tip" } };
  is("nor is another store's", (await readTip(store, id)).state, "waiting");
  session = { id, status: "complete", payment_status: "paid", amount_total: 500, currency: "usd", metadata: { store: "tipshop", kind: "tip" } };
  is("paid, to this store: thanked, with what Stripe took", await readTip(store, id), { state: "paid", amount: 500, currency: "usd" });
  is("and an id that is not one is not even asked about", (await readTip(store, "../account")).state, "waiting");
  done();
}

main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
