/**
 * Money end to end for bundles, discounted bundles in a cart and one-click
 * offers after paying (synthetic data only; Stripe and Resend are stand-ins
 * answering in their real API shapes).
 *
 * What is held:
 *
 *   - a bundle's price with a store-wide sale and the cart's deal: each line
 *     rounded as Stripe rounds a percentage, the sum of the lines the total the
 *     cart showed, never a code box on top of a discount, never negative, and
 *     the bundle's list on the order is what it can hand over now;
 *   - the cart's bundle swap says exactly the saving the checkout will charge,
 *     the deal counted both ways, and never offers a bundle already in the cart;
 *   - zero-decimal currencies (JPY): whole yen, no fractions;
 *   - a store-wide sale on one product never takes money off a checkbox
 *     product it does not cover;
 *   - a one-click offer after paying: charged = the offer's price, never more
 *     than the product costs on its own right now, never a coupon of the first
 *     order, once however often it is pressed, a bundle offered writes its
 *     list, and a product the buyer already got inside a bundle is not sold to
 *     them again;
 *   - Stripe's unknown answers (500, a payment still processing) are never
 *     taken as declined, nor as paid;
 *   - refunds: a partial refund keeps access (as lib/refunds.ts promises), a full
 *     one closes the offer, and the studio's kept money is charged − refunded.
 *
 * Gift cards and store credit for buyers do not exist in this repository (no
 * "gift card", "giftcard" or buyer "store credit" anywhere in lib/), so none is
 * tested here.
 */
import { TEST_CONSENT } from "./digital-consent-fixture";
import {
  addProduct,
  claimHandle,
  ensureStatsId,
  setCartDeal,
  setProductBundle,
  setProductExtras,
  setProductFunnel,
  setProductLink,
  setStoreSale,
  setStripeAccount,
  setSubscription,
  storeForEmail,
} from "@/lib/store";
import { readProduct } from "@/lib/catalog";
import { bestBundleSwap, cartTotal, swapped } from "@/lib/cart-bundle";
import { cartPrice, createCartCheckout } from "@/lib/cart-checkout";
import { salePrice } from "@/lib/store-sale";
import { bundleFromMeta, worthWords } from "@/lib/bundle-rules";
import { createCheckout } from "@/lib/store-checkout";
import { newUpsellKey, offerRefunded, readUpsell, settleUpsells, takeUpsell } from "@/lib/upsell";
import { readPaidSales, readSales } from "@/lib/stats";
import { shownRef } from "./upsell-ref-fixture";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";
import { paidPeriod } from "./billing-period-fixture";

process.env.STRIPE_SECRET_KEY = "sk_test_bundles_offers_only";
process.env.RESEND_API_KEY = "re_test_bundles_offers_only";

const OWNER = "bundles@example.com";
const BUYER = "buyer@example.com";
const ACCOUNT = "acct_1TestBundles001";
const NOW = Math.floor(Date.now() / 1000);

type Charge = { body: URLSearchParams; key: string };
const charges: Charge[] = [];
const checkouts: URLSearchParams[] = [];
/** What the next POST /payment_intents answers. */
let nextCharge: "succeeded" | "processing" | "server_error" | "declined" = "succeeded";
const made: Record<string, unknown>[] = [];
const sessions: Record<string, Record<string, unknown>> = {};
/** The lists the studio's numbers read. */
let sessionList: Record<string, unknown>[] = [];
let refundList: Record<string, unknown>[] = [];
/** Payments read one at a time, with the latest charge expanded. */
const payments: Record<string, Record<string, unknown>> = {};

globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const url = new URL(String(input));
  const answer = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
  if (url.hostname === "api.resend.com") return answer({ id: "email_1" });
  const path = url.pathname.replace(/^\/v1/, "");
  const method = init?.method ?? "GET";
  const list = (data: unknown[]) => answer({ object: "list", data, has_more: false, url: path });
  if (path === "/checkout/sessions" && method === "POST") {
    checkouts.push(new URLSearchParams(String(init?.body)));
    return answer({ id: `cs_test_${"c".repeat(24)}`, object: "checkout.session", url: "https://checkout.stripe.com/c/pay/test" });
  }
  if (path === "/checkout/sessions" && method === "GET") return list(sessionList);
  const session = /^\/checkout\/sessions\/(cs_test_[A-Za-z0-9]+)$/.exec(path);
  if (session && method === "GET") return sessions[session[1]] ? answer(sessions[session[1]]) : answer({ error: { message: "No such checkout.session" } }, 404);
  if (path === "/payment_intents" && method === "POST") {
    const body = new URLSearchParams(String(init?.body));
    const key = String((init?.headers as Record<string, string>)["Idempotency-Key"] ?? "");
    // A repeat of the same key is answered with the first result, as Stripe does.
    const again = made.find((pi) => pi.idempotency === key);
    if (again) return answer(again);
    charges.push({ body, key });
    if (nextCharge === "declined") return answer({ error: { type: "card_error", code: "card_declined", message: "Your card was declined." } }, 402);
    if (nextCharge === "server_error") return answer({ error: { type: "api_error", message: "An unknown error occurred." } }, 500);
    const pi = {
      id: `pi_test_${String(charges.length).padStart(10, "0")}`,
      object: "payment_intent",
      amount: Number(body.get("amount")),
      amount_received: nextCharge === "succeeded" ? Number(body.get("amount")) : 0,
      currency: body.get("currency"),
      status: nextCharge,
      customer: body.get("customer"),
      receipt_email: body.get("receipt_email"),
      created: NOW,
      livemode: false,
      next_action: null,
      metadata: Object.fromEntries([...body].filter(([k]) => k.startsWith("metadata[")).map(([k, v]) => [k.slice(9, -1), v])),
      idempotency: key,
    };
    made.push(pi);
    return answer(pi);
  }
  if (path === "/payment_intents" && method === "GET") {
    const customer = url.searchParams.get("customer");
    return list(customer ? made.filter((pi) => pi.customer === customer) : made);
  }
  const one = /^\/payment_intents\/(pi_[A-Za-z0-9_]+)$/.exec(path);
  if (one) {
    const found = payments[one[1]] ?? made.find((pi) => pi.id === one[1]);
    return found ? answer(found) : answer({ error: { message: "No such payment_intent" } }, 404);
  }
  if (path === "/refunds" && method === "GET") return list(refundList);
  if (method === "GET") return list([]);
  return answer({ error: { message: `no stand-in for ${method} ${path}` } }, 404);
}) as typeof fetch;

/** A paid checkout of the front product, as Stripe reports it, with the browser key it carried. */
function paidCheckout(id: string, product: string, fingerprint: string): Record<string, unknown> {
  return {
    id,
    object: "checkout.session",
    status: "complete",
    payment_status: "paid",
    created: NOW - 60,
    customer: "cus_TestBuyer01",
    currency: "usd",
    metadata: { store: "bundlehouse", product, upsell_key: fingerprint },
    customer_details: { email: BUYER },
    payment_intent: { id: "pi_test_front00001", payment_method: { id: "pm_test_card0001", type: "card", customer: "cus_TestBuyer01" } },
  };
}

/** The line items a checkout sends, as [name, unit_amount]. */
function linesOf(sent: URLSearchParams | undefined): [string, number][] {
  const out: [string, number][] = [];
  for (let i = 0; i < 6; i += 1) {
    const name = sent?.get(`line_items[${i}][price_data][product_data][name]`);
    if (name) out.push([name, Number(sent?.get(`line_items[${i}][price_data][unit_amount]`))]);
  }
  return out;
}

async function main(): Promise<void> {
  redis.clear();

  part("Pure: a percentage off each line, as Stripe rounds it");
  is("a third off $9.99 is $6.66, whole cents", salePrice(999, 33), 669);
  is("JPY: 15% off ¥999 is ¥849, whole yen", salePrice(999, 15), 849);
  is("the smallest price at the largest sale and deal never goes below zero", salePrice(salePrice(50, 70), 50) >= 0, true);
  is("no percentage leaves the price as it is", salePrice(4900, 0), 4900);
  const deal = { on: true, min: 2, percent: 10 };
  const cartLines = [{ cents: 1999 }, { cents: 2999 }, { cents: 4999 }];
  is(
    "the cart's total is the sum of its lines, each rounded on its own (what Stripe charges for price_data lines)",
    cartTotal(cartLines, deal),
    cartLines.reduce((sum, line) => sum + salePrice(line.cents, 10), 0),
  );

  part("Pure: the cart's bundle swap says exactly what the checkout will charge");
  const two = [{ id: "guide1", cents: 2900 }, { id: "sheet1", cents: 1900 }];
  const cheaper = bestBundleSwap(two, [{ id: "pack01", cents: 3900, items: ["guide1", "sheet1", "extra1"] }], undefined);
  is("a bundle that holds both and costs less is offered, replacing both", [cheaper?.id, cheaper?.replaces, cheaper?.more], ["pack01", ["guide1", "sheet1"], 1]);
  is("the saving said is exactly before − after", cheaper ? [cheaper.before, cheaper.after, cheaper.before - cheaper.after] : null, [4800, 3900, 900]);
  is("swapped, the cart holds the bundle alone: nothing paid twice", cheaper ? swapped(["guide1", "sheet1"], cheaper) : null, ["pack01"]);
  is("a bundle that costs more is never offered", bestBundleSwap(two, [{ id: "pack02", cents: 4900, items: ["guide1", "sheet1"] }], undefined), null);
  is("a bundle already in the cart is never offered again", bestBundleSwap([...two, { id: "pack01", cents: 3900 }], [{ id: "pack01", cents: 3900, items: ["guide1", "sheet1"] }], undefined), null);
  is("a bundle at zero is never offered", bestBundleSwap(two, [{ id: "pack03", cents: 0, items: ["guide1", "sheet1"] }], undefined), null);
  // Two lines at 10% off cost 4320; swapped for a $44 bundle the deal is lost (one line): 4400 is dearer.
  is(
    "the deal for buying more is counted both ways: a swap that loses it and costs more is not offered",
    bestBundleSwap(two, [{ id: "pack04", cents: 4400, items: ["guide1", "sheet1"] }], { on: true, min: 2, percent: 10 }),
    null,
  );
  const keeps = bestBundleSwap([...two, { id: "other1", cents: 1000 }], [{ id: "pack05", cents: 4000, items: ["guide1", "sheet1"] }], { on: true, min: 2, percent: 10 });
  is(
    "with the deal kept after the swap, the saving is taken with the deal on both sides",
    keeps ? [keeps.before, keeps.after] : null,
    [salePrice(2900, 10) + salePrice(1900, 10) + salePrice(1000, 10), salePrice(1000, 10) + salePrice(4000, 10)],
  );
  is("\"$48 of products for $39\" only when the products cost more", [worthWords([{ priceCents: 2900 }, { priceCents: 1900 }], 3900, "usd"), worthWords([{ priceCents: 2000 }, { priceCents: 1900 }], 3900, "usd")], ["$48 of products for $39", null]);

  // ---- The store ----
  await claimHandle(OWNER, "bundlehouse", "Bundle House", "");
  await ensureStatsId(OWNER);
  await setStripeAccount(OWNER, ACCOUNT, true);
  await setSubscription(OWNER, { customerId: "cus_Owner00001", subscriptionId: "sub_Owner00001", active: true, period: paidPeriod() });
  const add = async (title: string, price: string, link = true) => {
    const result = await addProduct(OWNER, title, "", price, null);
    if (!result.ok) throw new Error(`no product ${title}`);
    if (link) await setProductLink(OWNER, result.product.id, `https://example.com/${result.product.id}`);
    return result.product.id;
  };
  const guide = await add("Field Guide", "29");
  const sheet = await add("Cheat Sheet", "19");
  const extra = await add("Recipe Cards", "9");
  const pack = await add("Kitchen Pack", "39", false);
  const bundled = await setProductBundle(OWNER, pack, [guide, sheet, extra]);
  is("the bundle is saved with its three products", bundled.ok, true);

  part("A bundle in the cart during a store-wide sale and the cart's deal");
  await setStoreSale(OWNER, { name: "Spring", percent: 20, starts: NOW - 60, ends: NOW + 3_600, all: true, products: [], coupon: "cpn_Spring20" });
  await setCartDeal(OWNER, { on: true, min: 2, percent: 10 });
  let store = (await storeForEmail(OWNER))!;
  const packProduct = (await readProduct(store, pack))!;
  const guideProduct = (await readProduct(store, guide))!;
  checkouts.length = 0;
  await createCartCheckout(store, [packProduct, guideProduct], "https://marktmorgen.com", { digitalConsent: TEST_CONSENT });
  const cartSent = checkouts[0];
  const shownPack = cartPrice(store, packProduct, "").cents;
  const shownGuide = cartPrice(store, guideProduct, "").cents;
  is("the cart shows the sale price of each line", [shownPack, shownGuide], [salePrice(3900, 20), salePrice(2900, 20)]);
  is(
    "each line is charged at the shown price less the deal, rounded per line",
    linesOf(cartSent),
    [["Kitchen Pack", salePrice(shownPack, 10)], ["Field Guide", salePrice(shownGuide, 10)]],
  );
  is(
    "the sum of the lines is the total the cart showed (cartTotal), to the cent",
    linesOf(cartSent).reduce((sum, [, cents]) => sum + cents, 0),
    cartTotal([{ cents: shownPack }, { cents: shownGuide }], store.cartDeal),
  );
  is(
    "no coupon, no code box on top of the sale and the deal: never discounted a third time",
    [cartSent?.get("discounts[0][coupon]"), cartSent?.get("discounts[0][promotion_code]"), cartSent?.get("allow_promotion_codes")],
    [null, null, null],
  );
  is("the bundle's list on the order is what it hands over now", bundleFromMeta(Object.fromEntries(cartSent ? [...cartSent].filter(([k]) => k.startsWith("metadata[")).map(([k, v]) => [k.slice(9, -1), v]) : []), "bundle"), [guide, sheet, extra]);
  is("the deal is written on the order", cartSent?.get("metadata[cart_deal]"), "10");

  part("A store-wide sale on one product and a checkbox product it does not cover");
  const course = await add("Pastry Course", "49");
  const templates = await add("Pastry Templates", "19");
  is("the checkbox is set at $9", (await setProductExtras(OWNER, course, { bump: { productId: templates, priceCents: 900, pitch: "" }, slot: 0 })).ok, true);
  await setStoreSale(OWNER, { name: "Course only", percent: 20, starts: NOW - 60, ends: NOW + 3_600, all: false, products: [course], coupon: "cpn_Course20" });
  store = (await storeForEmail(OWNER))!;
  checkouts.length = 0;
  await createCheckout(store, (await readProduct(store, course))!, "https://marktmorgen.com", "", { bumps: [templates], digitalConsent: TEST_CONSENT });
  const single = checkouts[0];
  is("the course's line and the box's line, at their own prices", linesOf(single), [["Pastry Course", 4900], ["Pastry Templates", 900]]);
  // Stripe takes a coupon applied to a Checkout Session off every line item unless the coupon names the
  // products it applies to (applies_to.products); the sale's coupon is made with none (app/api/store/sale/route.ts:44-55),
  // and price_data lines have no product a coupon could name. So what Stripe charges is the percentage off each line.
  const percentOff = single?.get("discounts[0][coupon]") === "cpn_Course20" ? 20 : 0;
  const stripeCharges = linesOf(single).map(([name, cents]) => [name, salePrice(cents, percentOff)]);
  // The page shows the box at the front product's sale price too (components/store-product.tsx, salePrice of the
  // bump's price at the front product's percent), so the sale's coupon on the whole session charges what was shown.
  is("the box is charged what the page shows for it, the sale's percent off its own price", stripeCharges, [["Pastry Course", 3920], ["Pastry Templates", 720]]);
  // What the order says the box was charged (bump_cents) is its price before the discount, the weight an affiliate's
  // share is worked out by against Stripe's amount_subtotal, also before discounts (lib/affiliates.ts, orderLines).
  is("the box's recorded amount is its price before the discount, as the subtotal it is weighed against", Number(single?.get("metadata[bump_cents]")), 900);

  part("One-click offers after paying: discounted, a bundle, and what is in it");
  await setStoreSale(OWNER, { name: "", percent: 0, starts: 0, ends: 0, all: true, products: [], coupon: "" });
  const front = await add("Sourdough Course", "49");
  const funnelSteps = {
    steps: [
      { id: "pack01", productId: pack, priceCents: 3000, headline: "", text: "", imageFrom: null, yes: "sheet1", no: null },
      { id: "sheet1", productId: sheet, priceCents: 900, headline: "", text: "", imageFrom: null, yes: null, no: null },
    ],
  };
  // The studio refuses a funnel that offers, after the bundle, a product the bundle holds (DISC-B-2)...
  is("a funnel offering the bundle, then one of its products, is refused by the studio", (await setProductFunnel(OWNER, front, funnelSteps)).ok, false);
  // ...but the bundle can come to hold it after the funnel was saved: the thanks page must not charge it again.
  is("the bundle without the Cheat Sheet", (await setProductBundle(OWNER, pack, [guide, extra])).ok, true);
  const saved = await setProductFunnel(OWNER, front, {
    steps: [
      { id: "pack01", productId: pack, priceCents: 3000, headline: "", text: "", imageFrom: null, yes: "sheet1", no: null },
      { id: "sheet1", productId: sheet, priceCents: 900, headline: "", text: "", imageFrom: null, yes: null, no: null },
    ],
  });
  is("saved while the bundle does not hold the Cheat Sheet", saved.ok, true);
  is("and the Cheat Sheet put in the bundle afterwards", (await setProductBundle(OWNER, pack, [guide, sheet, extra])).ok, true);
  store = (await storeForEmail(OWNER))!;
  const origin = "https://marktmorgen.com";
  const browser = newUpsellKey();
  const take = async (session: string, step: string, answer: "yes" | "no") =>
    takeUpsell({ store, session, secret: browser.secret, origin, step: await shownRef(store, step), answer, consent: TEST_CONSENT });
  sessions.cs_test_bundleorder0001 = paidCheckout("cs_test_bundleorder0001", front, browser.fingerprint);
  is("yes to the bundle at $30 (its own price $39) is charged", (await take("cs_test_bundleorder0001", "pack01", "yes")).kind, "done");
  const first = charges[0];
  is(
    "charged the offer's price, once, in the store's currency, on the card just used",
    [charges.length, first?.body.get("amount"), first?.body.get("currency"), first?.body.get("payment_method")],
    [1, "3000", "usd", "pm_test_card0001"],
  );
  is(
    "no coupon, discount or promotion code of the first order rides on the offer's charge",
    first ? [...first.body.keys()].filter((k) => /discount|coupon|promotion/.test(k)) : null,
    [],
  );
  is("its own idempotency key, never the first order's", first?.key, "nimbus-upsell:cs_test_bundleorder0001");
  is("the bundle's list is written on its own payment", bundleFromMeta(first ? Object.fromEntries([...first.body].filter(([k]) => k.startsWith("metadata[")).map(([k, v]) => [k.slice(9, -1), v])) : null, "bundle"), [guide, sheet, extra]);
  is("and kept with the answer as what the buyer gets", (await readUpsell("cs_test_bundleorder0001"))?.items, [guide, sheet, extra]);
  is("pressed again: done, not charged again", [(await take("cs_test_bundleorder0001", "pack01", "yes")).kind, charges.length], ["done", 1]);
  // RED: DISC-B-2 — lib/funnel.ts:286-289 (funnelPosition) adds only the bundle's own id to what the buyer has
  // after a paid offer, not the products inside it, and lib/funnel.ts:156-158 checks "repeat" by product id only;
  // so the buyer who just paid for the bundle (which holds the Cheat Sheet) is charged again for the Cheat Sheet.
  const again = await take("cs_test_bundleorder0001", "sheet1", "yes");
  is(
    "RED: DISC-B-2: a product the buyer just got inside the bundle is not offered or charged again",
    [again.kind, charges.length],
    ["unavailable", 1],
  );

  part("A one-click offer is never dearer than the product on its own right now");
  const second = await add("Bread Course", "49");
  const tools = await add("Baker's Tools Guide", "29");
  await setProductFunnel(OWNER, second, {
    steps: [{ id: "tool01", productId: tools, priceCents: 1900, headline: "", text: "", imageFrom: null, yes: null, no: null }],
  });
  await setStoreSale(OWNER, { name: "Half", percent: 50, starts: NOW - 60, ends: NOW + 3_600, all: true, products: [], coupon: "cpn_Half50" });
  store = (await storeForEmail(OWNER))!;
  const onItsOwn = cartPrice(store, (await readProduct(store, tools))!, "").cents;
  is("on its own, during the sale, the guide costs $14.50", onItsOwn, 1450);
  sessions.cs_test_saleorder00001 = paidCheckout("cs_test_saleorder00001", second, browser.fingerprint);
  const before = charges.length;
  const taken = await take("cs_test_saleorder00001", "tool01", "yes");
  const amount = Number(charges[before]?.body.get("amount") ?? 0);
  // RED: DISC-B-3 — lib/upsell.ts:396 charges step.priceCents, and lib/funnel.ts:181 compares it with the
  // product's list price only (priceCents), never with the store-wide sale running now (lib/store-sale.ts saleOff):
  // the one-click "discount" charges $19 for what the store sells at $14.50 at that moment.
  is(
    "RED: DISC-B-3: charged no more than the product costs on its own during the sale",
    [taken.kind === "done" || taken.kind === "unavailable", amount <= onItsOwn],
    [true, true],
  );
  await setStoreSale(OWNER, { name: "", percent: 0, starts: 0, ends: 0, all: true, products: [], coupon: "" });
  store = (await storeForEmail(OWNER))!;

  part("Stripe's unknown answers never become declined or paid");
  nextCharge = "server_error";
  sessions.cs_test_unknownorder01 = paidCheckout("cs_test_unknownorder01", second, browser.fingerprint);
  const failedServer = await take("cs_test_unknownorder01", "tool01", "yes");
  is("a 500 is checking, kept pending, never declined", [failedServer.kind, (await readUpsell("cs_test_unknownorder01"))?.state], ["checking", "pending"]);
  nextCharge = "declined";
  sessions.cs_test_declinedorder1 = paidCheckout("cs_test_declinedorder1", second, browser.fingerprint);
  is("a card Stripe declined (402) is failed", [(await take("cs_test_declinedorder1", "tool01", "yes")).kind, (await readUpsell("cs_test_declinedorder1"))?.state], ["failed", "failed"]);
  nextCharge = "processing";
  sessions.cs_test_processorder01 = paidCheckout("cs_test_processorder01", second, browser.fingerprint);
  const processing = await take("cs_test_processorder01", "tool01", "yes");
  // RED: DISC-B-4 — lib/upsell.ts:456-462: any status other than "succeeded" or "requires_action" with a URL is
  // written "failed" and taken off the five-minute job's list. A PaymentIntent in "processing" (Link backed by a
  // bank account, which REUSABLE_METHODS admits; cards occasionally) can still succeed: the buyer would be charged,
  // told it was declined, and never handed the product, since settleOne only settles "pending".
  is(
    "RED: DISC-B-4: a payment still processing is checking/pending, never failed",
    [processing.kind, (await readUpsell("cs_test_processorder01"))?.state],
    ["checking", "pending"],
  );
  // The 500 answer above: Stripe later says it succeeded; settled as paid from the payment found, never charged again.
  nextCharge = "succeeded";
  const lostCharges = charges.length;
  made.push({
    id: "pi_test_lost000001",
    object: "payment_intent",
    amount: 1900,
    currency: "usd",
    status: "succeeded",
    customer: "cus_TestBuyer01",
    receipt_email: BUYER,
    created: NOW,
    metadata: { store: "bundlehouse", product: tools, kind: "upsell", parent: "cs_test_unknownorder01" },
  });
  await settleUpsells(store, "cs_test_unknownorder01");
  is("after a 500, Stripe's own payment settles it as paid, with no second charge", [(await readUpsell("cs_test_unknownorder01"))?.state, charges.length], ["paid", lostCharges]);
  is("pressed again after that: done, not charged", [(await take("cs_test_unknownorder01", "tool01", "yes")).kind, charges.length], ["done", lostCharges]);

  part("Refunds of a discounted offer");
  const charged = { id: "ch_test_offer000001", object: "charge", amount: 3000, amount_refunded: 1000, refunded: false, disputed: false };
  payments.pi_3TestOfferPart01 = { id: "pi_3TestOfferPart01", object: "payment_intent", amount: 3000, status: "succeeded", latest_charge: charged };
  is("a partial refund keeps access, as lib/refunds.ts promises", await offerRefunded(store, "pi_3TestOfferPart01"), false);
  payments.pi_3TestOfferFull01 = { id: "pi_3TestOfferFull01", object: "payment_intent", amount: 3000, status: "succeeded", latest_charge: { ...charged, id: "ch_test_offer000002", amount_refunded: 3000, refunded: true } };
  is("a full refund closes it", await offerRefunded(store, "pi_3TestOfferFull01"), true);
  payments.pi_3TestOfferOver01 = { id: "pi_3TestOfferOver01", object: "payment_intent", amount: 3000, status: "succeeded", latest_charge: { ...charged, id: "ch_test_offer000003", amount_refunded: 2999 } };
  is("one cent short of the whole is still partial", await offerRefunded(store, "pi_3TestOfferOver01"), false);
  is("a reference that is not a payment's id is not read as refunded", await offerRefunded(store, "cs_test_bundleorder0001"), false);

  part("The studio's numbers: charged amounts, refunds taken off");
  sessionList = [
    {
      id: "cs_test_listedorder001",
      object: "checkout.session",
      status: "complete",
      payment_status: "paid",
      mode: "payment",
      amount_total: 3120,
      amount_subtotal: 3900,
      total_details: { amount_discount: 780, amount_tax: 0 },
      currency: "usd",
      created: NOW - 3_600,
      payment_intent: "pi_test_listed000001",
      customer_details: { email: BUYER, address: { country: "US" } },
      metadata: { store: "bundlehouse", product: pack, bundle: [guide, sheet, extra].join(","), sale: "20" },
    },
  ];
  refundList = [{ id: "re_test_partial00001", object: "refund", amount: 1000, currency: "usd", status: "succeeded", created: NOW - 60, payment_intent: "pi_test_0000000001" }];
  const read = await readPaidSales(store, NOW - 86_400, 2);
  const upsells = read.sales.filter((s) => s.upsell);
  is("the discounted bundle sale is counted at what was charged, not its list price", read.sales.find((s) => !s.upsell)?.cents, 3120);
  const succeeded = made.filter((pi) => pi.status === "succeeded" && (pi.metadata as Record<string, string>).kind === "upsell").map((pi) => Number(pi.amount));
  is(
    "the offers are counted exactly at the amounts Stripe says succeeded; the processing, declined and errored ones are not",
    upsells.map((s) => s.cents).sort((a, b) => a - b),
    succeeded.sort((a, b) => a - b),
  );
  const kept = (await readSales(store))?.keptIn?.d7.lines.find((line) => line.currency === "usd");
  is(
    "the week's kept money is everything charged less the $10 refunded, to the cent",
    [kept?.salesCents, kept?.refundCents, kept?.keptCents],
    [3120 + succeeded.reduce((sum, cents) => sum + cents, 0), 1000, 3120 + succeeded.reduce((sum, cents) => sum + cents, 0) - 1000],
  );
  is("nothing unread or partial", read.partial, false);

  done();
}

void main();
