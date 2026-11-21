/**
 * The offers after paying, after a cart (556 [CT1], lib/cart-offers.ts;
 * added 1 November 2026). Against a stand-in for the creator's Stripe
 * account, checked:
 *
 *   - a cart with no product that has offers keeps no card and sets no key;
 *     one with such a product keeps the card exactly as one product does
 *     ("on_session", a customer made) and names whose offers follow;
 *   - whose: the first product in the cart's order with offers, never the
 *     next one's instead, and none when every offer is already in the cart;
 *   - passed over: what is in the cart, what the buyer bought here before,
 *     and what they turned down in this order; nothing left, nothing shown;
 *     what they own unreadable, nothing shown;
 *   - every protection of lib/upsell.ts holds after a cart: only the browser
 *     that paid, within the hour, a method one click cannot charge again
 *     meets no offer, each offer answered once, the bank's confirmation, and
 *     the offer's own price with the cart's deal not taken off again;
 *   - the checkout's named product is believed only when it is one of the
 *     cart's own lines;
 *   - the studio says it in one sentence, and an offer taken after a cart is
 *     the same "upsell" payment the numbers already count.
 */
import { readFileSync } from "node:fs";
import { TEST_CONSENT } from "./digital-consent-fixture";
import { addProduct, claimHandle, ensureStatsId, setCartDeal, setProductBundle, setProductFunnel, setProductLink, setStripeAccount, setSubscription, storeForEmail } from "@/lib/store";
import { readListing, readProduct } from "@/lib/catalog";
import { funnelView, newUpsellKey, readUpsell, takeUpsell } from "@/lib/upsell";
import { shownRef } from "./upsell-ref-fixture";
import { CART_OFFER_REQUEST_UNITS, cartOfferFrom, cartOfferOwner } from "@/lib/cart-offers";
import { createCartCheckout } from "@/lib/cart-checkout";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";
import { paidPeriod } from "./billing-period-fixture";

process.env.STRIPE_SECRET_KEY = "sk_test_cart_offers_only";
process.env.RESEND_API_KEY = "re_test_cart_offers_only";

const OWNER = "baker@example.com";
const BUYER = "buyer@example.com";
const RETURNING = "again@example.com";
const UNREADABLE = "many@example.com";
const ACCOUNT = "acct_1TestCartOff01";
const NOW = Math.floor(Date.now() / 1000);
const read = (file: string) => readFileSync(file, "utf8");

type Charge = { body: URLSearchParams; key: string };
const charges: Charge[] = [];
const opened: URLSearchParams[] = [];
let nextCharge: "succeeded" | "requires_action" = "succeeded";
const made: Record<string, unknown>[] = [];
let sessions: Record<string, Record<string, unknown>> = {};
/** What each address bought here before, as Stripe lists its completed checkouts. */
let before: Record<string, Record<string, unknown>[]> = {};
/** How many times what a buyer owns was listed from Stripe. */
let listCalls = 0;

globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const url = new URL(String(input));
  const answer = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
  if (url.hostname === "api.resend.com") return answer({ id: "email_1" });
  const path = url.pathname.replace(/^\/v1/, "");
  const method = init?.method ?? "GET";
  if (path === "/checkout/sessions" && method === "POST") {
    opened.push(new URLSearchParams(String(init?.body)));
    return answer({ id: "cs_test_cartopen000001", url: "https://checkout.stripe.com/c/pay/cs_test_cartopen000001" });
  }
  if (path === "/checkout/sessions" && method === "GET") {
    listCalls += 1;
    const email = url.searchParams.get("customer_details[email]") ?? "";
    if (email === UNREADABLE) return answer({ object: "list", data: [], has_more: true });
    return answer({ object: "list", data: before[email] ?? [], has_more: false });
  }
  const session = /^\/checkout\/sessions\/(cs_test_[A-Za-z0-9]+)$/.exec(path);
  if (session && method === "GET") return sessions[session[1]] ? answer(sessions[session[1]]) : answer({ error: { message: "no such checkout" } }, 404);
  if (path === "/payment_intents" && method === "POST") {
    const body = new URLSearchParams(String(init?.body));
    const key = String((init?.headers as Record<string, string>)["Idempotency-Key"] ?? "");
    charges.push({ body, key });
    const pi = {
      id: `pi_test_${String(charges.length).padStart(10, "0")}`,
      object: "payment_intent",
      amount: Number(body.get("amount")),
      currency: body.get("currency"),
      customer: body.get("customer"),
      status: nextCharge,
      created: NOW,
      metadata: Object.fromEntries([...body].filter(([k]) => k.startsWith("metadata[")).map(([k, v]) => [k.slice(9, -1), v])),
      ...(nextCharge === "requires_action" ? { next_action: { redirect_to_url: { url: "https://hooks.stripe.com/3ds/confirm" } } } : {}),
    };
    made.push(pi);
    return answer(pi);
  }
  if (path === "/payment_intents" && method === "GET") {
    return answer({ object: "list", data: made.filter((pi) => pi.customer === url.searchParams.get("customer")), has_more: false });
  }
  const one = /^\/payment_intents\/(pi_[A-Za-z0-9_]+)$/.exec(path);
  if (one) {
    const found = made.find((pi) => pi.id === one[1]);
    return found ? answer(found) : answer({ error: { message: "no such payment" } }, 404);
  }
  return answer({ error: { message: `no stand-in for ${method} ${path}` } }, 404);
}) as typeof fetch;

async function main(): Promise<void> {
  redis.clear();
  await claimHandle(OWNER, "harbor", "Harbor Kitchen", "");
  await ensureStatsId(OWNER);
  await setStripeAccount(OWNER, ACCOUNT, true);
  await setSubscription(OWNER, { customerId: "cus_Owner00001", subscriptionId: "sub_Owner00001", active: true, period: paidPeriod() });
  const add = async (title: string, price: string) => {
    const result = await addProduct(OWNER, title, "", price, null);
    if (!result.ok) throw new Error(`no product ${title}`);
    await setProductLink(OWNER, result.product.id, `https://example.com/${result.product.id}`);
    return result.product.id;
  };
  const bread = await add("Bread Basics", "39");
  const course = await add("Sourdough Course", "49");
  const kit = await add("Starter Kit Guide", "29");
  const prior = await add("Proofing Notes", "19");
  const list = await add("Starter Checklist", "9");
  const pastry = await add("Pastry Course", "59");
  // The course's offers: the kit, then after a no the notes, then after a no the checklist.
  const saved = await setProductFunnel(OWNER, course, {
    steps: [
      { id: "kit001", productId: kit, priceCents: 1900, headline: "", text: "", imageFrom: null, yes: null, no: "not001" },
      { id: "not001", productId: prior, priceCents: 900, headline: "", text: "", imageFrom: null, yes: null, no: "lst001" },
      { id: "lst001", productId: list, priceCents: 500, headline: "", text: "", imageFrom: null, yes: null, no: null },
    ],
  });
  is("the course's three offers are accepted", saved.ok, true);
  // The pastry course offers only the bread basics.
  // The rye course offers the kit, and after a no the same kit for less.
  const rye = await add("Rye Course", "45");
  const cheaper = await setProductFunnel(OWNER, rye, {
    steps: [
      { id: "rkt001", productId: kit, priceCents: 1900, headline: "", text: "", imageFrom: null, yes: null, no: "rkt002" },
      { id: "rkt002", productId: kit, priceCents: 1200, headline: "", text: "", imageFrom: null, yes: null, no: "rls001" },
      { id: "rls001", productId: list, priceCents: 500, headline: "", text: "", imageFrom: null, yes: null, no: null },
    ],
  });
  is("a funnel may offer the same product for less after a no", cheaper.ok, true);
  is("and the pastry course's one", (await setProductFunnel(OWNER, pastry, { steps: [{ id: "brd001", productId: bread, priceCents: 1500, headline: "", text: "", imageFrom: null, yes: null, no: null }] })).ok, true);
  // A bundle holding every offer the course could lead to (556 [CT1], unit 2).
  const starter = await add("Starter Bundle", "45");
  await setProductLink(OWNER, starter, null);
  is("the bundle holds the kit, the notes and the checklist", (await setProductBundle(OWNER, starter, [kit, prior, list])).ok, true);
  // Buy more, save more: 10% off each line from two products.
  await setCartDeal(OWNER, { on: true, min: 2, percent: 10 });
  const store = (await storeForEmail(OWNER))!;
  const p = async (id: string) => (await readProduct(store, id))!;
  const origin = "https://marktmorgen.com";

  part("Whose offers follow a cart");
  is("no product in it has offers: none", await cartOfferOwner(store, [await p(bread), await p(kit)]), null);
  is("the course, second in the cart, has them: its own", (await cartOfferOwner(store, [await p(bread), await p(course)]))?.id, course);
  is("its first offer is in the cart: still the course, its next offers are left", (await cartOfferOwner(store, [await p(course), await p(kit)]))?.id, course);
  is("every offer it could lead to is in the cart: none, and no card is kept for nothing", await cartOfferOwner(store, [await p(course), await p(kit), await p(prior), await p(list)]), null);
  is("every offer it could lead to is in a bundle in the cart: none, and no card is kept for nothing", await cartOfferOwner(store, [await p(course), await p(starter)]), null);
  is("the first with offers decides: the pastry course's only offer is in the cart, so none, never the course's instead", await cartOfferOwner(store, [await p(pastry), await p(bread), await p(course)]), null);

  part("The cart's checkout keeps the card only when offers follow");
  const browser = newUpsellKey();
  await createCartCheckout(store, [await p(bread), await p(course)], origin, { digitalConsent: TEST_CONSENT, offers: { upsellKey: browser.fingerprint, from: course } });
  const kept = opened.at(-1)!;
  is(
    "as for one product: a customer is made, the card kept for payments made while the buyer is there, the browser's key and whose offers",
    [kept.get("customer_creation"), kept.get("payment_method_options[card][setup_future_usage]"), kept.get("metadata[upsell_key]"), kept.get("metadata[offer_from]")],
    ["always", "on_session", browser.fingerprint, course],
  );
  is("the order is still the cart's, with its deal", [kept.get("metadata[cart]"), kept.get("metadata[cart_deal]")], ["yes", "10"]);
  await createCartCheckout(store, [await p(bread), await p(kit)], origin, { digitalConsent: TEST_CONSENT });
  const plain = opened.at(-1)!;
  is("without offers: no customer, no card kept, no key", [plain.has("customer_creation"), plain.has("payment_method_options[card][setup_future_usage]"), plain.has("metadata[upsell_key]"), plain.has("metadata[offer_from]")], [false, false, false, false]);
  await createCartCheckout(store, [await p(bread), await p(kit)], origin, { digitalConsent: TEST_CONSENT, offers: { upsellKey: browser.fingerprint, from: course } });
  is("a product named that is not in the cart: nothing kept either", opened.at(-1)!.has("metadata[offer_from]") || opened.at(-1)!.has("customer_creation"), false);

  part("Whose offers, read back from the checkout");
  is("a cart's line, first or added: believed", [cartOfferFrom({ cart: "yes", product: course, offer_from: course }), cartOfferFrom({ cart: "yes", product: bread, bump: course, offer_from: course })], [course, course]);
  is("anything else: nothing", [cartOfferFrom({ cart: "yes", product: bread, offer_from: course }), cartOfferFrom({ product: course, offer_from: course }), cartOfferFrom({ cart: "yes", product: course })], [null, null, null]);

  // A paid cart: the bread first, the course added, whose offers follow; the buyer's card kept.
  const paidCart = (id: string, email: string, more: Record<string, unknown> = {}, meta: Record<string, string> = {}) => ({
    id,
    status: "complete",
    payment_status: "paid",
    created: NOW - 60,
    customer: "cus_TestBuyer01",
    currency: "usd",
    amount_total: 7740,
    metadata: { store: "harbor", product: bread, bump: course, cart: "yes", cart_deal: "10", upsell_key: browser.fingerprint, offer_from: course, ...meta },
    customer_details: { email },
    payment_intent: { id: "pi_test_front00001", payment_method: { id: "pm_test_card0001", type: "card", customer: "cus_TestBuyer01" } },
    ...more,
  });
  const breadListing = (await readListing(store, bread))!;
  const take = async (session: string, step: string, answer: "yes" | "no", secret: string | undefined = browser.secret) =>
    takeUpsell({ store, session, secret, origin, step: await shownRef(store, step), answer, consent: TEST_CONSENT });
  // As the thanks page asks: the cart's first line, and every other line of the order (its "bumps").
  const view = (session: string, email: string, offerFrom: string | null = course, secret: string | undefined = browser.secret, alsoOwned: string[] = [course]) =>
    funnelView({ store, session, product: breadListing, alsoOwned, eligible: true, created: NOW - 60, secret, upsellKey: browser.fingerprint, cart: { offerFrom, email } });

  part("A cart with a product that has offers: the first offer not in it");
  sessions = { cs_test_cartpaid000001: paidCart("cs_test_cartpaid000001", BUYER) };
  is("the thanks page shows the course's first offer, the kit", (await view("cs_test_cartpaid000001", BUYER)).offer?.step.id, "kit001");
  is("yes to it charges the kit at the offer's own price: the cart's 10% is not taken off again", [(await take("cs_test_cartpaid000001", "kit001", "yes")).kind, charges.at(-1)?.body.get("amount")], ["done", "1900"]);
  is(
    "on the card just used, as the same \"upsell\" payment the numbers already count, after this order",
    [charges.at(-1)?.body.get("payment_method"), charges.at(-1)?.body.get("metadata[kind]"), charges.at(-1)?.body.get("metadata[parent]"), charges.at(-1)?.body.has("metadata[cart_deal]")],
    ["pm_test_card0001", "upsell", "cs_test_cartpaid000001", false],
  );
  is("pressed again: done, and charged once", [(await take("cs_test_cartpaid000001", "kit001", "yes")).kind, charges.length], ["done", 1]);
  is("the kit taken leads to the end: nothing more is shown", (await view("cs_test_cartpaid000001", BUYER)).offer, null);

  part("Passed over: in the cart, bought before, turned down");
  before = {
    [RETURNING]: [{ id: "cs_test_earlier00001", status: "complete", payment_status: "paid", customer: "cus_TestBuyer01", metadata: { store: "harbor", product: prior } }].map((row) => ({ ...row, customer: "cus_TestReturn01" })),
  };
  sessions.cs_test_cartpaid000002 = paidCart("cs_test_cartpaid000002", RETURNING, {}, { bump: course, bump2: kit });
  const shown = await view("cs_test_cartpaid000002", RETURNING, course, browser.secret, [course, kit]);
  is("the kit is in the cart and the notes were bought before: the checklist is the one shown", shown.offer?.step.id, "lst001");
  is("neither can be answered instead", [(await take("cs_test_cartpaid000002", "kit001", "yes")).kind, (await take("cs_test_cartpaid000002", "not001", "yes")).kind, charges.length], ["unavailable", "unavailable", 1]);
  is("no thanks to the checklist charges nothing", (await take("cs_test_cartpaid000002", "lst001", "no")).kind, "declined");
  is("and nothing is left: none shown, and the checklist is never asked again", [(await view("cs_test_cartpaid000002", RETURNING, course, browser.secret, [course, kit])).offer, (await take("cs_test_cartpaid000002", "lst001", "yes")).kind, charges.length], [null, "declined", 1]);
  is("the no is kept", (await readUpsell("cs_test_cartpaid000002", "lst001"))?.state, "declined");
  sessions.cs_test_cartpaid000003 = paidCart("cs_test_cartpaid000003", UNREADABLE);
  is("what the buyer owns cannot be read in full: nothing shown, nothing can be answered", [(await view("cs_test_cartpaid000003", UNREADABLE)).offer, (await take("cs_test_cartpaid000003", "kit001", "yes")).kind, charges.length], [null, "unavailable", 1]);
  is("a cart's checkout that named no product: nothing", (await view("cs_test_cartpaid000001", BUYER, null)).offer, null);

  part("Every protection of the offers after one product");
  sessions.cs_test_cartpaid000004 = paidCart("cs_test_cartpaid000004", BUYER);
  is("another browser: nothing shown, nothing charged", [(await view("cs_test_cartpaid000004", BUYER, course, newUpsellKey().secret)).offer, (await take("cs_test_cartpaid000004", "kit001", "yes", newUpsellKey().secret)).kind, charges.length], [null, "unavailable", 1]);
  sessions.cs_test_cartpaid000005 = paidCart("cs_test_cartpaid000005", BUYER, { created: NOW - 2 * 3600 });
  is("after the hour: nothing", (await take("cs_test_cartpaid000005", "kit001", "yes")).kind, "unavailable");
  sessions.cs_test_cartpaid000006 = paidCart("cs_test_cartpaid000006", BUYER, { payment_intent: { id: "pi_test_front00006", payment_method: { id: "pm_test_klarna01", type: "klarna", customer: null } } });
  is("paid with Klarna, which one click cannot charge again: nothing", [(await take("cs_test_cartpaid000006", "kit001", "yes")).kind, charges.length], ["unavailable", 1]);
  sessions.cs_test_cartpaid000007 = paidCart("cs_test_cartpaid000007", BUYER, {}, { offer_from: kit });
  is("a checkout naming a product that is not one of its lines: nothing", (await take("cs_test_cartpaid000007", "kit001", "yes")).kind, "unavailable");
  nextCharge = "requires_action";
  sessions.cs_test_cartpaid000008 = paidCart("cs_test_cartpaid000008", BUYER);
  const confirm = await take("cs_test_cartpaid000008", "kit001", "yes");
  is("the bank asks to confirm: sent there, nothing delivered yet", [confirm.kind, (await readUpsell("cs_test_cartpaid000008"))?.state], ["confirm", "pending"]);
  is("and nothing more is offered meanwhile", (await view("cs_test_cartpaid000008", BUYER)).offer, null);
  nextCharge = "succeeded";

  part("Turned down in this order: never again, not even for less");
  // The bank's confirmation above was one charge asked for; nothing after it is.
  const charged = charges.length;
  sessions.cs_test_cartpaid000009 = paidCart("cs_test_cartpaid000009", BUYER, {}, { product: rye, bump: bread, offer_from: rye });
  const ryeView = async (secret = browser.secret, eligible = true, created = NOW - 60) =>
    funnelView({ store, session: "cs_test_cartpaid000009", product: (await readListing(store, rye))!, alsoOwned: [bread], eligible, created, secret, upsellKey: browser.fingerprint, cart: { offerFrom: rye, email: BUYER } });
  is("the kit first", (await ryeView()).offer?.step.id, "rkt001");
  is("no thanks to it", (await take("cs_test_cartpaid000009", "rkt001", "no")).kind, "declined");
  is("the same kit for less is passed over: the checklist is next", (await ryeView()).offer?.step.id, "rls001");
  is("and the cheaper kit cannot be answered instead", [(await take("cs_test_cartpaid000009", "rkt002", "yes")).kind, charges.length - charged], ["unavailable", 0]);

  part("On the page too: the hour, and a method one click cannot charge again");
  is("after the hour, the page shows nothing", (await ryeView(browser.secret, true, NOW - 2 * 3600)).offer, null);
  is("paid with Klarna (the page's eligible is false), nothing", (await ryeView(browser.secret, false)).offer, null);

  part("The store's month of requests used: nothing is read, nothing is offered");
  for (const key of redis.keys().filter((k) => k.startsWith("nl:traffic:r:"))) await redis.pipeline([["INCRBY", key, 100_000_000]]);
  sessions.cs_test_cartpaid000010 = paidCart("cs_test_cartpaid000010", BUYER);
  const listsBefore = listCalls;
  is("the page shows no offer, and the answer is refused", [(await view("cs_test_cartpaid000010", BUYER)).offer, (await take("cs_test_cartpaid000010", "kit001", "yes")).kind, charges.length - charged], [null, "unavailable", 0]);
  is("and the buyer's purchases were never read from Stripe", listCalls, listsBefore);

  part("Its reads are counted, and the studio says it");
  is("what the buyer owns counts as many public requests as the next product after a purchase", CART_OFFER_REQUEST_UNITS, 6);
  is("counted before it is read", /takeBuyerRead\(store, CART_OFFER_REQUEST_UNITS\)\)\) return null;\s*return ownedHere\(store, email\);/.test(read("lib/cart-offers.ts")), true);
  is("the cart's form sets the browser's secret as one product's does", /cartOfferOwner\(store, products\)/.test(read("app/api/store/cart/route.ts")) && read("app/api/store/cart/route.ts").includes("`${UPSELL_COOKIE}=${upsell.secret}; Path=/; Max-Age=7200; HttpOnly; SameSite=Lax"), true);
  is("the thanks page passes the cart's named product and the address paid with", /cart: \(order\.record\.metadata as Record<string, string> \| null\)\?\.cart === "yes"\s*\? \{ offerFrom: cartOfferFrom\(/.test(read("app/[handle]/thanks/page.tsx")), true);
  is("the studio says so in one sentence", read("app/studio/funnels/page.tsx").includes("The offers also follow a purchase from the cart: those of the first product in the cart that has offers, never something already in the cart or bought before."), true);
  done();
}

void main();
