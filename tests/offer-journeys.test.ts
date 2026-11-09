/**
 * The three ways a buyer adds a product to an order, walked from end to end
 * against a stand-in Stripe (F11 order bumps, F12 offers after paying and
 * their downsells, F13 the cart; 17 October 2026). Every Stripe answer here
 * is synthetic and nothing real is reached. What is checked, for each path:
 *
 *   - explicit opt-in: nothing is added that the buyer did not choose. A box
 *     is never checked for them; an offer after paying is charged only on
 *     its own "yes", only for the offer they are at, only in the browser that
 *     paid, once however often it is pressed; "no thanks" leads to the
 *     cheaper offer and charges nothing;
 *   - the price shown is the price charged: each line at the creator's price
 *     for it, a store's sale taken off once (by Stripe's coupon on a checkout,
 *     already in the line on a cart, never both), an offer after paying at
 *     exactly its own price;
 *   - discounts do not stack: one coupon or the code box, never both, and no
 *     code box once something was taken off;
 *   - currency: every line in the store's currency, and no offer after paying
 *     an order in another; none while sales tax is on;
 *   - a refund in full closes everything the order handed over, bumps and a
 *     bundle's contents with it, and takes back the share and the affiliate's
 *     commission; a partial refund takes back only its part;
 *   - an affiliate credited by a code typed at checkout earns each product's
 *     own share of a bump: the defect this file was written with (the bump's
 *     amount was only written when the buyer came through a link).
 */
import { TEST_CONSENT } from "./digital-consent-fixture";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  addProduct,
  claimHandle,
  ensureStatsId,
  setProductExtras,
  setProductFunnel,
  setProductLink,
  setStripeAccount,
  setSubscription,
  storeForEmail,
  type Store,
} from "@/lib/store";
import { readProduct } from "@/lib/catalog";
import { createCheckout } from "@/lib/store-checkout";
import { createCartCheckout } from "@/lib/cart-checkout";
import { deliveredIds } from "@/lib/bundle-rules";
import { purchaseRefunded, refundedInFull } from "@/lib/refunds";
import { fingerprint, offerRefunded, takeUpsell } from "@/lib/upsell";
import { noteSession, settleLine } from "@/lib/affiliates";
import { applyShareToPayment, owedOn, toGiveBack } from "@/lib/platform-share";
import { salePrice } from "@/lib/store-sale";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";
import { paidPeriod } from "./billing-period-fixture";

const OWNER = "owner@example.com";
const ACCOUNT = "acct_1TestJourney001";
const SESSION = `cs_test_${"j".repeat(24)}`;
const SECRET = "browser-secret-of-the-buyer";

const checkouts: URLSearchParams[] = [];
const charges: URLSearchParams[] = [];
let session: Record<string, unknown> = {};
const intents: Record<string, Record<string, unknown>> = {};
globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const url = new URL(String(input));
  const path = url.pathname.replace(/^\/v1/, "");
  const method = init?.method ?? "GET";
  const answer = (body: unknown) => new Response(JSON.stringify(body));
  if (path === "/checkout/sessions" && method === "POST") {
    checkouts.push(new URLSearchParams(String(init?.body)));
    return answer({ id: `cs_test_${"b".repeat(24)}`, url: "https://checkout.stripe.com/c/pay/test" });
  }
  if (path === `/checkout/sessions/${SESSION}` && method === "GET") return answer(session);
  if (path === "/payment_intents" && method === "POST") {
    const body = new URLSearchParams(String(init?.body));
    charges.push(body);
    const metadata: Record<string, string> = {};
    for (const [key, value] of body) {
      const m = /^metadata\[(.+)\]$/.exec(key);
      if (m) metadata[m[1]] = value;
    }
    const pi = { id: `pi_up${charges.length}aaaaaa`, object: "payment_intent", status: "succeeded", amount: Number(body.get("amount")), currency: body.get("currency"), metadata, created: Math.floor(Date.now() / 1000) };
    intents[pi.id] = pi;
    return answer(pi);
  }
  const intent = /^\/payment_intents\/([^/?]+)$/.exec(path);
  if (intent && method === "GET" && intents[intent[1]]) return answer(intents[intent[1]]);
  if (method === "GET") return answer({ object: "list", data: [], has_more: false });
  return new Response(JSON.stringify({ error: { message: `no stand-in for ${method} ${path}` } }), { status: 404 });
}) as typeof fetch;

/** The lines of a checkout as sent: name, amount, currency. */
function lines(sent: URLSearchParams): [string, number, string][] {
  const out: [string, number, string][] = [];
  for (let i = 0; i < 8; i += 1) {
    const name = sent.get(`line_items[${i}][price_data][product_data][name]`);
    if (name) out.push([name, Number(sent.get(`line_items[${i}][price_data][unit_amount]`)), sent.get(`line_items[${i}][price_data][currency]`) ?? ""]);
  }
  return out;
}

/** The order's own metadata, as Stripe hands it back on the paid checkout. */
function metadataOf(sent: URLSearchParams): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of sent) {
    const m = /^metadata\[(.+)\]$/.exec(key);
    if (m) out[m[1]] = value;
  }
  return out;
}

async function main(): Promise<void> {
  redis.clear();
  process.env.STRIPE_SECRET_KEY = "sk_test_journeys_only_a_stand_in";

  await claimHandle(OWNER, "harbor", "Harbor Kitchen", "");
  await ensureStatsId(OWNER);
  await setStripeAccount(OWNER, ACCOUNT, true);
  await setSubscription(OWNER, { customerId: "cus_Owner00003", subscriptionId: "sub_Owner00003", active: true, period: paidPeriod() });
  const ids: Record<string, string> = {};
  for (const [title, price] of [["Course", "49"], ["Workbook", "29"], ["Checklist", "9"]]) {
    const made = await addProduct(OWNER, title, "", price, null);
    if (!made.ok) throw new Error(`no ${title}`);
    ids[title] = made.product.id;
    await setProductLink(OWNER, made.product.id, `https://example.com/${title.toLowerCase()}`);
  }
  await setProductExtras(OWNER, ids.Course, { bump: { productId: ids.Workbook, priceCents: 1900, pitch: "" }, slot: 0 });
  await setProductExtras(OWNER, ids.Course, { bump: { productId: ids.Checklist, priceCents: 500, pitch: "" }, slot: 1 });
  let store = (await storeForEmail(OWNER))!;
  const course = (await readProduct(store, ids.Course))!;
  const open = async (at: Store, bumps: string[]) => {
    checkouts.length = 0;
    await createCheckout(at, course, "https://marktmorgen.com", "", { bumps, digitalConsent: TEST_CONSENT });
    return checkouts[0];
  };

  part("F11 · A box at checkout: only what the buyer checks");
  const source = readFileSync(join(process.cwd(), "components/store-product.tsx"), "utf8");
  const box = source.slice(source.indexOf('name="bump"') - 200, source.indexOf('name="bump"') + 200);
  is("the box on the page is never checked for the buyer", /defaultChecked|\bchecked[=\s{]/.test(box), false);
  let sent = await open(store, []);
  is("nothing checked: the product alone", lines(sent).map(([name]) => name), ["Course"]);
  sent = await open(store, [ids.Checklist]);
  is("one checked: that one alone is added, at the creator's price for it", lines(sent), [["Course", 4900, "usd"], ["Checklist", 500, "usd"]]);
  sent = await open(store, [ids.Workbook, ids.Checklist, "notoffered1"]);
  is("a product the form names that no box offers is ignored; no price comes from the form", lines(sent), [["Course", 4900, "usd"], ["Workbook", 1900, "usd"], ["Checklist", 500, "usd"]]);
  is("the button's total is what the lines charge", lines(sent).reduce((sum, [, cents]) => sum + cents, 0), 4900 + 1900 + 500);
  is("with no discount, the code box is offered, once", [sent.get("allow_promotion_codes"), sent.has("discounts[0][coupon]")], [store.hasDiscounts ? "true" : null, false]);
  is("each box's amount is written on every order, not only an affiliate's", [sent.get("metadata[bump_cents]"), sent.get("metadata[bump2_cents]")], ["1900", "500"]);

  const now = Math.floor(Date.now() / 1000);
  const onSale: Store = { ...store, hasDiscounts: true, sale: { name: "Spring", percent: 15, starts: now - 60, ends: now + 3600, all: true, products: [], coupon: "springsale15" } };
  sent = await open(onSale, [ids.Workbook]);
  is("on sale: each line at its own price, so the coupon takes 15% off once", lines(sent), [["Course", 4900, "usd"], ["Workbook", 1900, "usd"]]);
  is("the sale's coupon, and no code box beside it", [sent.get("discounts[0][coupon]"), sent.get("allow_promotion_codes"), sent.get("metadata[sale]")], ["springsale15", null, "15"]);
  is("what the page says the box costs on sale is what that coupon leaves of it", salePrice(1900, Number(sent.get("metadata[sale]"))), 1615);

  sent = await open({ ...store, currency: "eur" }, [ids.Workbook]);
  is("every line in the store's currency", lines(sent).map(([, , currency]) => currency), ["eur", "eur"]);

  part("F11 · A refund in full closes what the box added too");
  const meta = metadataOf(await open(store, [ids.Workbook, ids.Checklist]));
  is("the order hands over the product and every box checked", deliveredIds(meta), [ids.Course, ids.Workbook, ids.Checklist]);
  const paid = (refunded: number) => ({ mode: "payment", metadata: meta, payment_intent: { object: "payment_intent", latest_charge: { object: "charge", amount: 7300, amount_refunded: refunded, refunded: refunded >= 7300 } } });
  is("refunded in full: every door closes, the boxes' with it", await purchaseRefunded(ACCOUNT, paid(7300)), true);
  is("refunded in part (the creator kept part of the price): the buyer keeps what it paid for", await purchaseRefunded(ACCOUNT, paid(1900)), false);

  part("F11 · An affiliate credited by a code earns each product's own share");
  const AFF = "0123456789ab";
  await redis.pipeline([["HSET", `nl:aff:${store.statsId}:people`, AFF, JSON.stringify({ id: AFF, email: "sara@example.com", code: "sara", status: "approved", appliedAt: 1, decidedAt: 2, note: "" })]]);
  // 20% across the store, with the workbook taken out of the programme.
  const programme: Store = { ...store, affiliates: { ...store.affiliates, enabled: true, percent: 20, rates: { [ids.Workbook]: 0 } } };
  const order = {
    id: `cs_test_${"k".repeat(24)}`,
    mode: "payment",
    status: "complete",
    payment_status: "paid",
    created: now,
    amount_total: 6800,
    amount_subtotal: 6800,
    currency: "usd",
    total_details: { amount_tax: 0, amount_shipping: 0 },
    payment_intent: "pi_codesale0001",
    metadata: metadataOf(await open(store, [ids.Workbook])),
    customer_details: { email: "buyer@example.com" },
    discounts: [{ promotion_code: "promo_saracode000001" }],
  };
  await noteSession(programme, order, new Map([["promo_saracode000001", AFF]]));
  const [raw] = await redis.pipeline([["HGET", `nl:aff:${store.statsId}:sales`, order.id]]);
  const written = typeof raw === "string" ? (JSON.parse(raw) as { aff: string; rate: number }) : null;
  const credited = written ? { aff: written.aff, rate: written.rate } : null;
  // $49 at 20% plus $19 at 0% is $9.80 of $68: 14.41% over the order, not 20% of all of it.
  is("the workbook, out of the programme, earns nothing even through a code", credited, { aff: AFF, rate: 14.41 });

  part("F12 · Offers after paying, and the cheaper one after a no");
  const steps = [
    { id: "offerone", productId: ids.Workbook, priceCents: 1900, headline: "", text: "", imageFrom: null, yes: null, no: "offertwo" },
    { id: "offertwo", productId: ids.Checklist, priceCents: 500, headline: "", text: "", imageFrom: null, yes: null, no: null },
  ];
  is("the funnel is saved", (await setProductFunnel(OWNER, ids.Course, { steps })).ok, true);
  store = (await storeForEmail(OWNER))!;
  session = {
    id: SESSION,
    status: "complete",
    payment_status: "paid",
    created: Math.floor(Date.now() / 1000) - 60,
    currency: "usd",
    customer: "cus_Buyer0001",
    metadata: { store: "harbor", product: ids.Course, upsell_key: fingerprint(SECRET) },
    customer_details: { email: "buyer@example.com" },
    payment_intent: { id: "pi_front0001", payment_method: { id: "pm_card0001", type: "card", customer: "cus_Buyer0001" } },
  };
  const take = (step: string, answer: "yes" | "no", secret = SECRET, at: Store = store) => takeUpsell({ store: at, session: SESSION, secret, origin: "https://marktmorgen.com", step, answer, consent: TEST_CONSENT });
  is("another browser, without the buyer's secret, can charge nothing", (await take("offerone", "yes", "someone-else")).kind, "unavailable");
  is("with sales tax on, nothing is offered after paying", (await take("offerone", "yes", SECRET, { ...store, tax: { ...store.tax, enabled: true } })).kind, "unavailable");
  session = { ...session, currency: "eur" };
  is("an order in another currency than the offers' is followed by none", (await take("offerone", "yes")).kind, "unavailable");
  session = { ...session, currency: "usd" };
  is("the cheaper offer cannot be skipped to before the first is answered", (await take("offertwo", "yes")).kind, "unavailable");
  is("nothing was charged by any of that", charges.length, 0);
  is("no thanks: declined, and nothing charged", [(await take("offerone", "no")).kind, charges.length], ["declined", 0]);
  is("yes to the cheaper offer after the no", (await take("offertwo", "yes")).kind, "done");
  is("charged once, exactly its own price, in the order's currency, on the card just used", charges.map((c) => [c.get("amount"), c.get("currency"), c.get("payment_method"), c.get("metadata[kind]"), c.get("metadata[parent]")]), [["500", "usd", "pm_card0001", "upsell", SESSION]]);
  is("pressed again: still one charge", [(await take("offertwo", "yes")).kind, charges.length], ["done", 1]);
  is("an offer already answered no stays no", (await take("offerone", "yes")).kind, "declined");

  part("F12 · A refund in full of an offer closes it on its own");
  const reference = Object.keys(intents)[0];
  intents[reference] = { ...intents[reference], latest_charge: { object: "charge", amount: 500, amount_refunded: 500, refunded: true } };
  is("its own payment, refunded in full, is refunded", await offerRefunded(store, reference), true);
  intents[reference] = { ...intents[reference], latest_charge: { object: "charge", amount: 500, amount_refunded: 0, refunded: false } };
  is("not refunded, it stays open", await offerRefunded(store, reference), false);

  part("The share and the commission follow a refund");
  const body = new URLSearchParams();
  const fee = applyShareToPayment(body, { shared: true, subscriptionActive: true, trialEnds: 0, tier: "creator" } as never, 500, Date.now() / 1000, true);
  is("an offer's share is taken on exactly what was charged", [Number(body.get("metadata[share_base]")), fee > 0], [500, true]);
  is("refunded in full: none of the share is owed, all of it is given back", toGiveBack({ amount: fee, refunded: 0 }, owedOn({ bps: Number(body.get("metadata[share_bps]")), base: 500, amount: 500, refunded: 500, lostDispute: false })), fee);
  const half = owedOn({ bps: Number(body.get("metadata[share_bps]")), base: 500, amount: 500, refunded: 250, lostDispute: false });
  is("refunded in half: half the share is owed, never more", half <= Math.floor(fee / 2) && half >= Math.floor(fee / 2) - 1, true);
  const sale = { ref: "cs_x", pi: "pi_x", aff: AFF, at: now, product: ids.Course, title: "Course + Workbook", base: 6800, total: 6800, currency: "usd", rate: 20, self: false, how: "click" as const };
  is("the affiliate's commission on a sale refunded in full is nothing", [settleLine(sale, 6800).commission, settleLine(sale, 6800).status], [0, "refunded"]);
  is("on one refunded in part, on what was kept", [settleLine(sale, 1900).commission, settleLine(sale, 1900).status], [980, "partly refunded"]);

  part("F13 · The cart: the price shown is the price charged, one discount at a time");
  const cartStore: Store = { ...store, hasDiscounts: true, cartDeal: { on: true, min: 2, percent: 10 } };
  const workbook = (await readProduct(store, ids.Workbook))!;
  const checklist = (await readProduct(store, ids.Checklist))!;
  checkouts.length = 0;
  await createCartCheckout(cartStore, [course, workbook, checklist], "https://marktmorgen.com", { digitalConsent: TEST_CONSENT });
  sent = checkouts[0];
  is("each line already at the deal's price, in the store's currency", lines(sent), [["Course", 4410, "usd"], ["Workbook", 2610, "usd"], ["Checklist", 810, "usd"]]);
  is("so no coupon and no code box is added on top", [sent.has("discounts[0][coupon]"), sent.get("allow_promotion_codes")], [false, null]);
  is("every product named so each is handed over as if bought alone", deliveredIds(metadataOf(sent)), [ids.Course, ids.Workbook, ids.Checklist]);
  checkouts.length = 0;
  await createCartCheckout({ ...cartStore, cartDeal: { on: false, min: 2, percent: 10 } }, [course, workbook], "https://marktmorgen.com", { digitalConsent: TEST_CONSENT });
  is("nothing taken off: the lines at their prices, and the code box", [lines(checkouts[0]).map(([, cents]) => cents), checkouts[0].get("allow_promotion_codes")], [[4900, 2900], "true"]);
  is("a cart refunded in full closes all of it", refundedInFull({ object: "charge", amount: 7830, amount_refunded: 7830 }), true);

  done();
}

void main();
