/**
 * Money hunt, end to end: coupons and discount codes (synthetic only; no
 * network, no real Stripe, no email).
 *
 * Every code here is the creator's own on their connected Stripe account
 * (lib/discount.ts). Stripe works out what a code takes off a checkout it
 * applies, so the money the platform itself decides is: the line amount it
 * sends beside a code, which discount goes on (one at a time), the figures of
 * a booking with a deposit where the code is taken off before Stripe's page
 * (lib/deposit-code.ts), what may come off for the platform's share
 * (lib/platform-share.ts, leastPaid / codesMayTakeOff), the coupons it makes
 * itself (lib/fair-coupon.ts), a code put on a running membership
 * (lib/member-discount.ts), the once-only link of a code for returning buyers
 * (lib/returning-code.ts) and the one-click offer after a purchase made with a
 * code (lib/upsell.ts).
 *
 * Invariants held at each step, through the real exported code:
 *   1. the amount sent to Stripe is the product's own price, the discount
 *      named only as Stripe's coupon or promotion code, never a second one;
 *   2. a figure the platform computes is in whole smallest units, rounded as
 *      Stripe rounds a percent coupon, whole yen for JPY, never below zero
 *      and never a charge under Stripe's minimum passed as a paid deposit;
 *   3. a code that is ended, not started, of another product or currency,
 *      limited or deleted never comes off where Stripe cannot count it;
 *   4. one use at a time where the platform holds the use (SET NX), under
 *      Promise.all against the in-memory Redis;
 *   5. an unknown, partial or malformed Stripe reply is never success, a
 *      discount, a paid offer or "nothing comes off".
 *
 * Parts headed "RED: DISC-C-<n>:" fail on purpose on main and name the
 * defect; every other part passes.
 */
import { TEST_CONSENT } from "./digital-consent-fixture";
import { shownRef } from "./upsell-ref-fixture";
import { paidPeriod } from "./billing-period-fixture";
import { createHash } from "node:crypto";
import {
  addProduct, claimHandle, ensureStatsId, setHasDiscounts, setProductFunnel, setProductLink, setReturningCodes,
  setStripeAccount, setSubscription, storeForEmail, type Store,
} from "@/lib/store";
import { readProduct } from "@/lib/catalog";
import { codesMayTakeOff, createCode, livePromotionId } from "@/lib/discount";
import { readCodeAsked } from "@/lib/discount-input";
import { depositWithCode, readDepositCode, readDepositCodeRow } from "@/lib/deposit-code";
import { leastPaid } from "@/lib/platform-share";
import { salePrice } from "@/lib/store-sale";
import { createCheckout, ReturningCodeRefused } from "@/lib/store-checkout";
import { fairCoupon } from "@/lib/fair-coupon";
import { applyMemberDiscount } from "@/lib/member-discount";
import { redeemReturningLink, spendReturningLink } from "@/lib/returning-code";
import { discountImpact, discountOff } from "@/lib/discount-impact";
import { newUpsellKey, readUpsell, takeUpsell } from "@/lib/upsell";
import { store as redis, redisPipeline } from "./redis-stub";
import { done, is, part } from "./check";

process.env.STRIPE_SECRET_KEY = "sk_test_money_e2e_coupons_stand_in";
process.env.RESEND_API_KEY = "re_test_money_e2e_coupons_only";

const OWNER = "money-coupons@example.com";
const HANDLE = "couponshop";
const ACCOUNT = "acct_1TestCoupons001";
const BUYER = "buyer@example.com";
const SEC = Math.floor(Date.now() / 1000);

// ---------------------------------------------------------------------------
// A synthetic Stripe account (and Resend), answering by path in real shapes.
// ---------------------------------------------------------------------------
type Json = Record<string, unknown>;
const list = (data: unknown[], hasMore = false): Json => ({ object: "list", data, has_more: hasMore });
const answer = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
const stripeError = (status: number, message: string, code?: string) => answer({ error: { type: status >= 500 ? "api_error" : "invalid_request_error", message, ...(code ? { code } : {}) } }, status);

/** What GET /promotion_codes answers, given its query. */
let promotionCodes: (q: URLSearchParams) => Response = () => answer(list([]));
/** Every POST /checkout/sessions body, and what the next one answers. */
const checkouts: URLSearchParams[] = [];
let checkoutAnswer: (body: URLSearchParams) => Response = () => answer({ id: `cs_test_${"c".repeat(24)}`, object: "checkout.session", url: "https://checkout.stripe.com/c/pay/test" });
/** Coupons on the account, by id (Stripe refuses a second with the same id). */
const coupons = new Map<string, Json>();
let couponCreates = 0;
const couponBodies: URLSearchParams[] = [];
const promotionBodies: URLSearchParams[] = [];
/** The member's customers and memberships, and what POST /subscriptions/:id answers. */
let memberSubscriptions: Json[] = [];
let subscriptionUpdate: (id: string, body: URLSearchParams) => Response = (id) => answer({ id, object: "subscription", discounts: ["di_1"] });
const subscriptionUpdates: URLSearchParams[] = [];
/** Checkouts read back by id (the thanks page, the offer after paying). */
const sessions: Record<string, Json> = {};
/** POST /payment_intents bodies with their idempotency keys, and what the next one answers. */
const intents: { body: URLSearchParams; key: string }[] = [];
let intentAnswer: (body: URLSearchParams, n: number) => Response = (body, n) =>
  answer({ id: `pi_test_${String(n).padStart(10, "0")}`, object: "payment_intent", amount: Number(body.get("amount")), currency: body.get("currency"), status: "succeeded", created: SEC, metadata: {} });

globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const url = new URL(String(input));
  if (url.hostname === "api.resend.com") return answer({ id: "email_test_1" });
  if (url.origin !== "https://api.stripe.com") throw new Error(`no network in this test: ${url}`);
  const path = url.pathname.replace(/^\/v1/, "");
  const method = init?.method ?? "GET";
  const q = url.searchParams;
  const body = new URLSearchParams(typeof init?.body === "string" ? init.body : String(init?.body ?? ""));
  if (path === "/promotion_codes" && method === "GET") return promotionCodes(q);
  // One code read by its id (lib/discount.ts findCode, on main since the member discount reads one code, not the list):
  // answered from the same synthetic codes, with Stripe's own 404 for a code that is not there.
  const one = path.match(/^\/promotion_codes\/([^/]+)$/);
  if (one && method === "GET") {
    const listed = promotionCodes(new URLSearchParams({ code: "SPRING", active: "true" }));
    const every = listed.status === 200 ? promotionCodes(new URLSearchParams()) : listed;
    if (every.status !== 200) return every;
    const rows = [listed, every].map(async (r) => ((await r.clone().json()) as Json).data);
    const seen = (await Promise.all(rows)).flatMap((d) => (Array.isArray(d) ? (d as Json[]) : []));
    const found = seen.find((c) => c.id === decodeURIComponent(one[1]));
    return found ? answer(found) : stripeError(404, "No such promotion_code", "resource_missing");
  }
  if (path === "/promotion_codes" && method === "POST") {
    promotionBodies.push(body);
    return answer({ id: "promo_1Made0001", object: "promotion_code", code: body.get("code"), active: body.get("active") !== "false", times_redeemed: 0, max_redemptions: body.has("max_redemptions") ? Number(body.get("max_redemptions")) : null, expires_at: null, restrictions: { first_time_transaction: false, minimum_amount: null, minimum_amount_currency: null }, promotion: { type: "coupon", coupon: body.get("promotion[coupon]") } });
  }
  if (path === "/checkout/sessions" && method === "POST") {
    checkouts.push(body);
    return checkoutAnswer(body);
  }
  if (path === "/coupons" && method === "POST") {
    couponBodies.push(body);
    couponCreates += 1;
    const id = body.get("id") ?? `co_1Made${String(couponCreates).padStart(4, "0")}`;
    if (coupons.has(id)) return stripeError(400, `Coupon already exists.`, "resource_already_exists");
    const made: Json = { id, object: "coupon", percent_off: body.has("percent_off") ? Number(body.get("percent_off")) : null, amount_off: body.has("amount_off") ? Number(body.get("amount_off")) : null, currency: body.get("currency"), duration: body.get("duration"), valid: true };
    coupons.set(id, made);
    return answer(made);
  }
  const coupon = /^\/coupons\/([^/]+)$/.exec(path);
  if (coupon && method === "GET") {
    const found = coupons.get(decodeURIComponent(coupon[1]));
    return found ? answer(found) : stripeError(404, "No such coupon", "resource_missing");
  }
  if (path === "/customers" && method === "GET") return answer(list([{ id: "cus_TestMember01", object: "customer", email: q.get("email") }]));
  if (path === "/subscriptions" && method === "GET") return answer(list(memberSubscriptions));
  const sub = /^\/subscriptions\/(sub_[A-Za-z0-9]+)$/.exec(path);
  if (sub && method === "POST") {
    subscriptionUpdates.push(body);
    return subscriptionUpdate(sub[1], body);
  }
  const session = /^\/checkout\/sessions\/(cs_test_[A-Za-z0-9]+)$/.exec(path);
  if (session && method === "GET") return sessions[session[1]] ? answer(sessions[session[1]]) : stripeError(404, "No such checkout.session", "resource_missing");
  if (path === "/payment_intents" && method === "POST") {
    const key = String((init?.headers as Record<string, string>)["Idempotency-Key"] ?? "");
    intents.push({ body, key });
    return intentAnswer(body, intents.length);
  }
  if (path === "/payment_intents" && method === "GET") return answer(list([]));
  return stripeError(404, `no stand-in for ${method} ${path}`);
}) as typeof fetch;

// ---------------------------------------------------------------------------
// Fixtures in Stripe's shapes.
// ---------------------------------------------------------------------------
/** A promotion code with its coupon expanded (and applies_to, as readDepositCode asks). */
const promo = (over: Json = {}, coupon: Json = {}): Json => ({
  id: "promo_1Spring0001",
  object: "promotion_code",
  code: "SPRING",
  active: true,
  expires_at: null,
  max_redemptions: null,
  times_redeemed: 0,
  customer: null,
  restrictions: { first_time_transaction: false, minimum_amount: null, minimum_amount_currency: null },
  promotion: { type: "coupon", coupon: { id: "co_1Spring", object: "coupon", percent_off: 33, amount_off: null, currency: null, duration: "once", applies_to: null, valid: true, redeem_by: null, max_redemptions: null, ...coupon } },
  ...over,
});
const keyOf = (token: string) => `nl:rcode:link:${createHash("sha256").update(`nimbus-rcode:${token}`).digest("hex").slice(0, 40)}`;

async function main(): Promise<void> {
  redis.clear();
  const realError = console.error;
  console.error = () => {};

  await claimHandle(OWNER, HANDLE, "Coupon Shop", "");
  await ensureStatsId(OWNER);
  await setStripeAccount(OWNER, ACCOUNT, true);
  await setSubscription(OWNER, { customerId: "cus_Owner000001", subscriptionId: "sub_Owner000001", active: true, period: paidPeriod() });
  await setHasDiscounts(OWNER, true);
  const add = async (title: string, price: string) => {
    const made = await addProduct(OWNER, title, "", price, null);
    if (!made.ok) throw new Error(`no product ${title}`);
    await setProductLink(OWNER, made.product.id, `https://example.com/${made.product.id}`);
    return made.product.id;
  };
  const guideId = await add("Pricing Guide", "9.99");
  const kitId = await add("Template Kit", "29");
  let store = (await storeForEmail(OWNER)) as Store;
  const guide = (await readProduct(store, guideId))!;
  const origin = "https://marktmorgen.com";
  const open = (s: Store, extras: Parameters<typeof createCheckout>[4] = {}) =>
    createCheckout(s, guide, origin, undefined, { digitalConsent: TEST_CONSENT, ...extras });

  // -------------------------------------------------------------------------
  part("1. A code from a link: what Stripe is sent is the price shown, the discount only Stripe's");
  // -------------------------------------------------------------------------
  promotionCodes = (q) => answer(list(q.get("code") === "SPRING" && q.get("active") === "true" ? [promo()] : []));
  await open(store, { code: "SPRING" });
  let sent = checkouts.at(-1)!;
  is("the line is the product's own price, $9.99, never a figure worked out here", sent.get("line_items[0][price_data][unit_amount]"), "999");
  is("the creator's live promotion code goes on by itself, the box is not offered beside it", [sent.get("discounts[0][promotion_code]"), sent.get("allow_promotion_codes")], ["promo_1Spring0001", null]);
  is("one discount only: no coupon beside the code, and the code kept with the sale", [sent.get("discounts[0][coupon]"), sent.get("discounts[1][coupon]"), sent.get("discounts[1][promotion_code]"), sent.get("metadata[code]")], [null, null, null, "SPRING"]);
  is("Stripe's arithmetic, read back as the page shows it: 33% of $9.99 is $3.30 off, $6.69 paid", [salePrice(999, 33), leastPaid(999, [{ kind: "percent", percent: 33 }])], [669, 669]);

  await open(store, { code: "NOPE" });
  sent = checkouts.at(-1)!;
  is("a code nobody made: the box, as without a code, and the price unchanged", [sent.get("discounts[0][promotion_code]"), sent.get("allow_promotion_codes"), sent.get("line_items[0][price_data][unit_amount]")], [null, "true", "999"]);

  part("1b. A store-wide sale: Stripe's coupon on the full price, never the code beside it");
  const saleStore: Store = { ...store, sale: { name: "Spring", percent: 33, starts: SEC - 3600, ends: SEC + 86_400, all: true, products: [], coupon: "co_1SaleSpring" } };
  await open(saleStore, { code: "SPRING" });
  sent = checkouts.at(-1)!;
  is("the full price on the line, the sale's coupon, no code, no box", [sent.get("line_items[0][price_data][unit_amount]"), sent.get("discounts[0][coupon]"), sent.get("discounts[0][promotion_code]"), sent.get("allow_promotion_codes"), sent.get("metadata[sale]")], ["999", "co_1SaleSpring", null, null, "33"]);
  const endedSale: Store = { ...store, sale: { ...saleStore.sale, ends: SEC - 1 } };
  const notYet: Store = { ...store, sale: { ...saleStore.sale, starts: SEC + 3600 } };
  const otherProduct: Store = { ...store, sale: { ...saleStore.sale, all: false, products: [kitId] } };
  for (const [what, s] of [["ended", endedSale], ["not yet started", notYet], ["for another product", otherProduct]] as const) {
    await open(s);
    sent = checkouts.at(-1)!;
    is(`a sale ${what}: no coupon, full price`, [sent.get("discounts[0][coupon]"), sent.get("line_items[0][price_data][unit_amount]")], [null, "999"]);
  }

  // -------------------------------------------------------------------------
  part("2. Stripe refuses the code at checkout (used up, ended, deleted, another product)");
  // -------------------------------------------------------------------------
  checkoutAnswer = (body) => body.has("discounts[0][promotion_code]")
    ? stripeError(400, "This promotion code has been used up and is no longer valid.", "coupon_expired")
    : answer({ id: `cs_test_${"d".repeat(24)}`, object: "checkout.session", url: "https://checkout.stripe.com/c/pay/box" });
  const reopened = await open(store, { code: "SPRING" });
  sent = checkouts.at(-1)!;
  is("the checkout opens with the box, at the full price, and the code is not kept as if it applied", [reopened.url, sent.get("discounts[0][promotion_code]"), sent.get("metadata[code]"), sent.get("allow_promotion_codes"), sent.get("line_items[0][price_data][unit_amount]")], ["https://checkout.stripe.com/c/pay/box", null, null, "true", "999"]);
  checkoutAnswer = () => stripeError(500, "An unknown error occurred.");
  let threw = "";
  await open(store, { code: "SPRING" }).catch((error: unknown) => { threw = error instanceof Error ? error.message : String(error); });
  is("a 500 from Stripe is an error, never a checkout and never a box opened as if the code was refused", /Stripe request failed \(500/.test(threw), true);
  checkoutAnswer = () => answer({ id: `cs_test_${"e".repeat(24)}`, object: "checkout.session", url: "" });
  threw = "";
  await open(store, { code: "SPRING" }).catch((error: unknown) => { threw = error instanceof Error ? error.message : String(error); });
  is("a checkout answered without a page to pay on is no checkout", threw, "Stripe did not return a checkout URL");
  checkoutAnswer = () => answer({ id: `cs_test_${"c".repeat(24)}`, object: "checkout.session", url: "https://checkout.stripe.com/c/pay/test" });

  part("2b. A code for returning buyers whose coupon Stripe will not take: no checkout at a price not asked for");
  const returning = { code: "THANKS10", coupon: "co_1Thanks10", off: { kind: "percent" as const, percent: 10 }, endsAt: null, createdAt: SEC - 86_400 };
  checkoutAnswer = (body) => body.get("discounts[0][coupon]") === "co_1Thanks10"
    ? stripeError(400, "No such coupon: 'co_1Thanks10'", "resource_missing")
    : answer({ id: `cs_test_${"c".repeat(24)}`, url: "https://checkout.stripe.com/c/pay/test" });
  let refused: unknown = null;
  await open(store, { returning, email: BUYER }).catch((error: unknown) => { refused = error; });
  is("a deleted coupon refuses the checkout with the code's own reason", refused instanceof ReturningCodeRefused && refused.reason === "code", true);
  refused = null;
  await open(saleStore, { returning, email: BUYER }).catch((error: unknown) => { refused = error; });
  is("another discount already applies: refused, never two discounts and never the code dropped quietly", refused instanceof ReturningCodeRefused && refused.reason === "other", true);
  checkoutAnswer = () => answer({ id: `cs_test_${"c".repeat(24)}`, object: "checkout.session", url: "https://checkout.stripe.com/c/pay/test" });

  // -------------------------------------------------------------------------
  part("3. Unknown replies to the code lookup never become a discount");
  // -------------------------------------------------------------------------
  promotionCodes = () => stripeError(500, "An unknown error occurred.");
  is("500: no code (the box)", await livePromotionId(ACCOUNT, "SPRING"), null);
  promotionCodes = () => answer({ object: "list", data: "promo_1Spring0001" });
  is("a list that is not a list: no code", await livePromotionId(ACCOUNT, "SPRING"), null);
  promotionCodes = () => answer(list([promo({ active: false })]));
  is("a code switched off (ended, or scheduled and not started): no code", await livePromotionId(ACCOUNT, "SPRING"), null);
  is("something that is not a code is never asked about", await livePromotionId(ACCOUNT, "<x>"), null);

  // lib/discount.ts:462 (livePromotionId): the row is taken by `row.active !== false` alone, without checking that it
  // is the code asked for, that its id is a promotion code's, or that `active` is there at all (readDepositCode,
  // lib/deposit-code.ts:161, checks the code). Scenario: Stripe's answer to "code=SPRING" names another code, another
  // object, or a row with no `active`; each is applied to the checkout as the buyer's code.
  const odd = [
    promo({ id: "promo_1Other0001", code: "STAFF90" }),
    { id: "cus_TestMember01", object: "customer" },
    { id: "promo_1NoActive01", object: "promotion_code", code: "SPRING" },
  ];
  const oddAnswers: (string | null)[] = [];
  for (const row of odd) {
    promotionCodes = () => answer(list([row]));
    oddAnswers.push(await livePromotionId(ACCOUNT, "SPRING"));
  }
  is("RED: DISC-C-1: a row for another code, another object or with no `active` is never taken as the buyer's code", oddAnswers, [null, null, null]);

  // -------------------------------------------------------------------------
  part("4. A code typed for a booking with a deposit: figures worked out here (lib/deposit-code.ts)");
  // -------------------------------------------------------------------------
  const deposit = (row: Json, priceCents: number, dep: number, currency: "usd" | "jpy" | "eur" = "usd") =>
    depositWithCode(readDepositCodeRow(row)!, { priceCents, deposit: dep, currency, nowSeconds: SEC });
  is("33% of $99.99, $20 deposit: $33.00 off (Stripe's rounding), $66.99, $20 now, $46.99 in person", deposit(promo(), 9999, 2000), { ok: true, figures: { off: 3300, discounted: 6699, charged: 2000, rest: 4699 } });
  const r = deposit(promo({}, { percent_off: 33 }), 999 * 7, 1500);
  is("every figure whole, and off + charged + rest is the price", r.ok && [Number.isInteger(r.figures.off), r.figures.off + r.figures.charged + r.figures.rest], [true, 6993]);
  is("JPY: ¥1,500 off ¥10,000, ¥3,000 deposit: whole yen, never ×100", deposit(promo({}, { percent_off: null, amount_off: 1500, currency: "jpy" }), 10_000, 3000, "jpy"), { ok: true, figures: { off: 1500, discounted: 8500, charged: 3000, rest: 5500 } });
  is("JPY percent: 33% of ¥999 is ¥330 off, ¥669", deposit(promo(), 999, 300, "jpy"), { ok: true, figures: { off: 330, discounted: 669, charged: 300, rest: 369 } });
  is("an amount larger than the price: never negative, never a charge under Stripe's minimum", deposit(promo({}, { percent_off: null, amount_off: 6000, currency: "usd" }), 5000, 2000), { ok: false, why: "small" });
  is("100% off: refused, not a free booking passed as a paid deposit", deposit(promo({}, { percent_off: 100 }), 5000, 2000), { ok: false, why: "small" });
  is("a code that leaves less than the deposit: the deposit falls to what is left, nothing in person", deposit(promo({}, { percent_off: null, amount_off: 4000, currency: "usd" }), 5000, 2000), { ok: true, figures: { off: 4000, discounted: 1000, charged: 1000, rest: 0 } });
  is("a code that leaves less than Stripe's minimum: refused", deposit(promo({}, { percent_off: null, amount_off: 4960, currency: "usd" }), 5000, 2000), { ok: false, why: "small" });
  is("expired (expires_at passed), switched off (not started): unknown", [deposit(promo({ expires_at: SEC - 1 }), 5000, 2000), deposit(promo({ active: false }), 5000, 2000)], [{ ok: false, why: "unknown" }, { ok: false, why: "unknown" }]);
  is("a coupon deleted or ended (valid false, redeem_by), or for some products only: refused", [deposit(promo({}, { valid: false }), 5000, 2000), deposit(promo({}, { redeem_by: SEC + 86_400 }), 5000, 2000), deposit(promo({}, { applies_to: { products: ["prod_Other"] } }), 5000, 2000)], [{ ok: false, why: "limited" }, { ok: false, why: "limited" }, { ok: false, why: "limited" }]);
  is("one use left (a cap, its own or its coupon's), or first order only: refused, as nothing here could count it", [deposit(promo({ max_redemptions: 5, times_redeemed: 4 }), 5000, 2000), deposit(promo({}, { max_redemptions: 1 }), 5000, 2000), deposit(promo({ restrictions: { first_time_transaction: true } }), 5000, 2000)], [{ ok: false, why: "limited" }, { ok: false, why: "limited" }, { ok: false, why: "limited" }]);
  is("an amount in another currency, with no option for the store's: unknown; with one: that option", [deposit(promo({}, { percent_off: null, amount_off: 1000, currency: "usd" }), 5000, 2000, "eur"), deposit(promo({}, { percent_off: null, amount_off: 1000, currency: "usd", currency_options: { eur: { amount_off: 900 } } }), 5000, 2000, "eur")], [{ ok: false, why: "unknown" }, { ok: true, figures: { off: 900, discounted: 4100, charged: 2000, rest: 2100 } }]);
  is("a minimum not met, or in another currency: unknown", [deposit(promo({ restrictions: { minimum_amount: 6000, minimum_amount_currency: "usd" } }), 5000, 2000), deposit(promo({ restrictions: { minimum_amount: 100, minimum_amount_currency: "eur" } }), 5000, 2000)], [{ ok: false, why: "unknown" }, { ok: false, why: "unknown" }]);
  is("a coupon not expanded (only its id): no code", readDepositCodeRow(promo({ promotion: { type: "coupon", coupon: "co_1Spring" } })), null);

  promotionCodes = () => stripeError(500, "An unknown error occurred.");
  const reads = [await readDepositCode(ACCOUNT, "spring")];
  promotionCodes = () => answer({ object: "list", data: null });
  reads.push(await readDepositCode(ACCOUNT, "spring"));
  promotionCodes = () => answer(list([promo(), promo({ id: "promo_1Spring0002" })]));
  reads.push(await readDepositCode(ACCOUNT, "spring"));
  promotionCodes = () => answer(list([promo({ code: "STAFF90" })]));
  reads.push(await readDepositCode(ACCOUNT, "spring"));
  is("500, a list that is not one, two rows, another code: no code (unknown is never a discount)", reads, [null, null, null, null]);

  // -------------------------------------------------------------------------
  part("5. A code made in the studio: whole smallest units, JPY whole yen");
  // -------------------------------------------------------------------------
  is("$7.50 off reads 750 cents; ¥1500 reads 1500 yen, never 150000", [readCodeAsked({ code: "save", kind: "amount", amount: "7.50" }, "usd"), readCodeAsked({ code: "yen", kind: "amount", amount: "1500" }, "jpy")], [
    { ok: true, asked: { code: "SAVE", off: { kind: "amount", cents: 750, currency: "usd" }, maxRedemptions: null, minimum: null } },
    { ok: true, asked: { code: "YEN", off: { kind: "amount", cents: 1500, currency: "jpy" }, maxRedemptions: null, minimum: null } },
  ]);
  is("yen with decimals, 0%, 101%, 0 uses, a fraction of a use: refused", [readCodeAsked({ code: "yen", kind: "amount", amount: "15.5" }, "jpy"), readCodeAsked({ code: "zero", percent: "0" }, "usd"), readCodeAsked({ code: "over", percent: "101" }, "usd"), readCodeAsked({ code: "none", percent: "10", uses: "0" }, "usd"), readCodeAsked({ code: "half", percent: "10", uses: "1.5" }, "usd")].map((x) => x.ok ? "ok" : x.reason), ["amount", "percent", "percent", "uses", "uses"]);
  const madeYen = await createCode(ACCOUNT, "YEN", { kind: "amount", cents: 1500, currency: "jpy" }, 1, null);
  const yenCoupon = couponBodies.at(-1)!;
  const yenPromo = promotionBodies.at(-1)!;
  is("Stripe is asked for ¥1500 off once, capped at one use on both the coupon and the code", [madeYen.ok, yenCoupon.get("amount_off"), yenCoupon.get("currency"), yenCoupon.get("duration"), yenCoupon.get("max_redemptions"), yenPromo.get("max_redemptions"), yenPromo.get("promotion[coupon]")], [true, "1500", "jpy", "once", "1", "1", "co_1Made0001"]);

  // -------------------------------------------------------------------------
  part("6. What may come off, for the platform's share (lib/platform-share.ts)");
  // -------------------------------------------------------------------------
  is("leastPaid: an amount larger than the price is 0, never negative; unknown is 0", [leastPaid(2900, [{ kind: "cents", cents: 5000 }]), leastPaid(2900, [{ kind: "unknown" }]), leastPaid(2900, [{ kind: "percent", percent: 100 }])], [0, 0, 0]);
  promotionCodes = () => stripeError(500, "An unknown error occurred.");
  const mays = [await codesMayTakeOff(ACCOUNT, "usd")];
  promotionCodes = () => answer(list([promo()], true));
  mays.push(await codesMayTakeOff(ACCOUNT, "usd"));
  promotionCodes = () => answer(list([promo({}, { percent_off: null, amount_off: null })]));
  mays.push(await codesMayTakeOff(ACCOUNT, "usd"));
  mays.push(await codesMayTakeOff(null, "usd"));
  is("500, more than one page, a coupon that cannot be read, no account: unknown, never nothing off", mays, [[{ kind: "unknown" }], [{ kind: "unknown" }], [{ kind: "unknown" }], [{ kind: "unknown" }]]);
  promotionCodes = () => answer(list([promo(), promo({ id: "promo_1Ten0001", code: "TEN" }, { percent_off: null, amount_off: 1000, currency: "usd" })]));
  is("the largest of each kind, in the checkout's currency", await codesMayTakeOff(ACCOUNT, "usd"), [{ kind: "percent", percent: 33 }, { kind: "cents", cents: 1000 }]);

  // lib/discount.ts:488-489 (codesMayTakeOff): an amount coupon in another currency is skipped as if it took nothing
  // off, but a Stripe coupon carries `currency_options` (amounts in other currencies), and the request (line 481)
  // never expands them. Scenario: a $10 coupon with a €50 option on an EUR store. Stripe takes €50 off a checkout
  // the platform's share was set on as if nothing came off.
  promotionCodes = () => answer(list([promo({}, { percent_off: null, amount_off: 1000, currency: "usd", currency_options: { eur: { amount_off: 5000 } } })]));
  is("RED: DISC-C-2: a coupon in another currency with an option for this one counts that option (or is unknown), never nothing off", await codesMayTakeOff(ACCOUNT, "eur"), [{ kind: "cents", cents: 5000 }]);

  // -------------------------------------------------------------------------
  part("7. Coupons the platform makes: two checkouts at once make one coupon (lib/fair-coupon.ts)");
  // -------------------------------------------------------------------------
  const before = couponCreates;
  const both = await Promise.all([fairCoupon(ACCOUNT, 30), fairCoupon(ACCOUNT, 30)]);
  is("both checkouts get the same coupon, and only one exists, taking 30% off", [both[0], both[1], [...coupons.keys()].filter((id) => id === both[0]).length, coupons.get(both[0])?.percent_off], [both[0], both[0], 1, 30]);
  is("Stripe was asked at most twice, and once known it is not asked again", [couponCreates - before <= 2, await fairCoupon(ACCOUNT, 30), couponCreates - before <= 2], [true, both[0], true]);
  coupons.set("mm_fair_40", { id: "mm_fair_40", object: "coupon", percent_off: 90, valid: true });
  let wrong = "";
  await fairCoupon(ACCOUNT, 40).catch((error: unknown) => { wrong = error instanceof Error ? error.message : ""; });
  is("a coupon of that id that takes off another amount is never used", wrong.includes("is not the fair price"), true);

  // -------------------------------------------------------------------------
  part("8. The returning buyers' link: one use, even at the same moment (lib/returning-code.ts)");
  // -------------------------------------------------------------------------
  store = (await setReturningCodes(OWNER, [returning, { ...returning, code: "OLDCODE", coupon: "co_1Old", endsAt: SEC - 60 }]))!;
  const token = "a".repeat(64);
  await redisPipeline([["SET", keyOf(token), JSON.stringify({ s: HANDLE, p: guideId, c: "THANKS10", e: BUYER }), "EX", 1800]]);
  const race = await Promise.all([redeemReturningLink(store, guideId, token), redeemReturningLink(store, guideId, token)]);
  is("of two uses at once, one opens the checkout with the code and the other waits", race.map((x) => (x.ok ? "ok" : x.reason)).sort(), ["busy", "ok"]);
  await spendReturningLink(token);
  const spent = await redeemReturningLink(store, guideId, token);
  is("spent once its checkout opened: never a second checkout with the code", spent.ok ? "ok" : spent.reason, "link");
  const t2 = "b".repeat(64);
  await redisPipeline([["SET", keyOf(t2), JSON.stringify({ s: HANDLE, p: guideId, c: "OLDCODE", e: BUYER }), "EX", 1800]]);
  const t3 = "c".repeat(64);
  await redisPipeline([["SET", keyOf(t3), JSON.stringify({ s: HANDLE, p: guideId, c: "THANKS10", e: BUYER }), "EX", 1800]]);
  const ended = await redeemReturningLink(store, guideId, t2);
  const otherProd = await redeemReturningLink(store, kitId, t3);
  is("a code ended since the link was sent, or a link for another product: refused", [ended.ok ? "ok" : ended.reason, otherProd.ok ? "ok" : otherProd.reason], ["code", "link"]);

  // -------------------------------------------------------------------------
  part("9. A code put on a running membership (lib/member-discount.ts)");
  // -------------------------------------------------------------------------
  memberSubscriptions = [{ id: "sub_TestMember01", object: "subscription", status: "active", metadata: { store: HANDLE, product: guideId }, items: { object: "list", data: [{ price: { unit_amount: 999, currency: "usd", recurring: { interval: "month" } } }] }, discounts: [] }];
  promotionCodes = () => answer(list([promo()]));
  is("a live code on a member's membership, once per membership (idempotent)", await applyMemberDiscount(store, BUYER, "sub_TestMember01", "promo_1Spring0001"), { ok: true });
  is("Stripe is sent the promotion code, nothing worked out here", subscriptionUpdates.at(-1)?.get("discounts[0][promotion_code]"), "promo_1Spring0001");
  subscriptionUpdate = () => stripeError(400, "This promotion code cannot be redeemed because it has expired.");
  is("refused by the code's own rules (ended, used up): said as refused", await applyMemberDiscount(store, BUYER, "sub_TestMember01", "promo_1Spring0001"), { ok: false, reason: "refused" });
  subscriptionUpdate = () => stripeError(500, "An unknown error occurred.");
  is("500: unknown, never applied", await applyMemberDiscount(store, BUYER, "sub_TestMember01", "promo_1Spring0001"), { ok: false, reason: "stripe" });
  promotionCodes = () => answer(list([promo({ active: false })]));
  is("a code switched off: refused before Stripe is asked", await applyMemberDiscount(store, BUYER, "sub_TestMember01", "promo_1Spring0001"), { ok: false, reason: "code" });
  promotionCodes = () => answer(list([promo()]));
  memberSubscriptions = [{ ...memberSubscriptions[0], discounts: ["di_1Already"] }];
  is("a membership already discounted: never a second discount on it", await applyMemberDiscount(store, BUYER, "sub_TestMember01", "promo_1Spring0001"), { ok: false, reason: "discounted" });
  memberSubscriptions = [{ ...memberSubscriptions[0], discounts: [] }];

  // lib/member-discount.ts:161-162 (applyMemberDiscount): any 2xx answer is { ok: true } without reading it, while
  // stopCode/activateCode (lib/discount.ts:404, :431) demand the same id and the state asked for. Scenario: Stripe's
  // answer is empty, names another subscription, or carries no discount; the studio says the member's renewals are
  // discounted while Stripe keeps charging the full price.
  const shapes: Json[] = [{}, { id: "sub_TestOther001", object: "subscription", discounts: ["di_1"] }, { id: "sub_TestMember01", object: "subscription", discounts: [] }];
  const applied: unknown[] = [];
  for (const shape of shapes) {
    subscriptionUpdate = () => answer(shape);
    applied.push(await applyMemberDiscount(store, BUYER, "sub_TestMember01", "promo_1Spring0001"));
  }
  is("RED: DISC-C-3: an answer that does not show this membership with a discount is never \"applied\"", applied, [{ ok: false, reason: "stripe" }, { ok: false, reason: "stripe" }, { ok: false, reason: "stripe" }]);
  subscriptionUpdate = (id) => answer({ id, object: "subscription", discounts: ["di_1"] });

  // -------------------------------------------------------------------------
  part("10. The offer after a purchase made with a code (lib/upsell.ts)");
  // -------------------------------------------------------------------------
  const funnel = await setProductFunnel(OWNER, guideId, { steps: [{ id: "kit001", productId: kitId, priceCents: 1900, headline: "", text: "", imageFrom: null, yes: null, no: null }] });
  is("a funnel: the kit at $19 after the guide", funnel.ok, true);
  store = (await storeForEmail(OWNER)) as Store;
  const browser = newUpsellKey();
  const paidWithCode = (id: string): Json => ({
    id, object: "checkout.session", status: "complete", payment_status: "paid", created: SEC - 60, customer: "cus_TestBuyer01", currency: "usd",
    amount_subtotal: 999, amount_total: 669, total_details: { amount_discount: 330, amount_shipping: 0, amount_tax: 0 },
    discounts: [{ coupon: null, promotion_code: "promo_1Spring0001" }],
    metadata: { store: HANDLE, product: guideId, upsell_key: browser.fingerprint, code: "SPRING" },
    customer_details: { email: BUYER },
    payment_intent: { id: "pi_test_front00001", payment_method: { id: "pm_test_card0001", type: "card", customer: "cus_TestBuyer01" } },
  });
  sessions.cs_test_codeorder000001 = paidWithCode("cs_test_codeorder000001");
  const take = async (session: string) => takeUpsell({ store, session, secret: browser.secret, origin, step: await shownRef(store, "kit001"), answer: "yes", consent: TEST_CONSENT });
  const took = await take("cs_test_codeorder000001");
  const charged = intents.at(-1)!;
  is("the offer is charged at its own price, $19, with no code, coupon or discount carried over", [took.kind, charged.body.get("amount"), [...charged.body.keys()].filter((k) => /discount|coupon|promotion/.test(k))], ["done", "1900", []]);
  const again = await take("cs_test_codeorder000001");
  is("pressed again (a replay): no second charge", [again.kind, intents.length], ["done", 1]);

  // lib/upsell.ts:445-446 (takeUpsell): a reply with status "succeeded" is recorded paid whatever its id and object,
  // and countOrder keys it `offer:${id}`. Scenario: Stripe's answer names another object (a charge) or no id at all;
  // the offer is written down as paid on an id that is not this payment (no id: every such offer shares "offer:").
  const odds: Json[] = [{ id: "ch_test_notanintent", object: "charge", status: "succeeded", amount: 1900, currency: "usd" }, { object: "payment_intent", status: "succeeded", amount: 1900, currency: "usd" }];
  const states: unknown[] = [];
  for (const [i, reply] of odds.entries()) {
    const id = `cs_test_codeorder00000${i + 2}`;
    sessions[id] = paidWithCode(id);
    intentAnswer = () => answer(reply);
    await take(id);
    states.push((await readUpsell(id))?.state ?? null);
  }
  is("RED: DISC-C-4: a \"succeeded\" answer that is not this payment intent is never written down as paid", states.map((s) => s !== "paid"), [true, true]);

  // -------------------------------------------------------------------------
  part("11. The creator's numbers for a discounted sale, partly refunded (lib/discount-impact.ts)");
  // -------------------------------------------------------------------------
  const row = (pi: string, total: number, off: number, meta: Json = {}): Json => ({ id: `cs_${pi}`, amount_total: total, total_details: { amount_discount: off }, metadata: { store: HANDLE, ...meta }, customer_details: { email: BUYER } });
  const now = Date.now();
  const sold = [
    { created: now - 86_400_000, cents: 669, currency: "usd", upsell: false, paymentIntent: "pi_code1", row: row("pi_code1", 669, 330, { code: "SPRING" }) },
    { created: now - 86_400_000, cents: 999, currency: "usd", upsell: false, paymentIntent: "pi_full1", row: row("pi_full1", 999, 0) },
    { created: now - 86_400_000 + 600_000, cents: 1900, currency: "usd", upsell: true, paymentIntent: "pi_up1", row: row("pi_up1", 1900, 0) },
  ];
  const impact = discountImpact(sold, new Set(["pi_code1"]), "usd", now);
  is("the code's row: what was paid after it, what it took off, and the partial refund counted, never the list price", impact?.find((x) => x.kind === "code"), { kind: "code", sales: 1, cents: 669, off: 330, refunded: 1, buyers: 1, again: 0 });
  is("the offer after paying is not counted as a discounted checkout", impact?.reduce((n, x) => n + x.sales, 0), 2);
  is("off read only from Stripe's discount or the booking's note, never negative or a string", [discountOff(row("x", 0, -5)), discountOff({ metadata: { code_off: "1.5" } }), discountOff({ metadata: { code_off: "300" } })], [0, 0, 300]);

  console.error = realError;
  done();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
