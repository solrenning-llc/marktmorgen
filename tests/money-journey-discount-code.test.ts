/**
 * Money journey, end to end: a discount code, from the creator making it to
 * the buyer's receipt (C2-159 item 4, part 2). The other tests check each
 * step on its own (tests/discount-rules.test.ts, tests/code-link.test.ts,
 * tests/purchase-email-paid-line.test.ts); this one walks through all of
 * them in order, with the real code at every step and only Stripe and the
 * email sender simulated:
 *
 *   1. the creator, signed in, makes the code SPRING, 25% off, good for one
 *      use, through the studio's real route (POST /api/store/discount): one
 *      coupon and one promotion code on the creator's own Stripe account,
 *      and the store now offers a code box;
 *   2. a buyer with no code gets the box on Stripe's page and nothing taken
 *      off;
 *   3. a buyer who came through the link with ?code=SPRING (the cookie the
 *      proxy sets) pays through the real checkout route
 *      (POST /api/store/checkout): the code goes on by itself, by the id of
 *      the creator's own promotion code, and the order says so;
 *   4. Stripe takes $36.75 for the $49 product: readOrder reads that amount,
 *      and the confirmation says the $36.75 paid, once;
 *   5. the code used up, Stripe refuses it for the next buyer: the checkout
 *      still opens, with the box, and the buyer is never turned away;
 *   6. the creator stops the code: with no live code left the store offers no
 *      box, the next buyer with the link pays the full price, and the
 *      studio's list shows it off.
 *
 * Each step reads what the one before wrote, so a break anywhere fails the
 * journey. Synthetic data only: no real Stripe, email or Redis.
 */
import { NextRequest } from "next/server";
import { POST as discountRoute } from "@/app/api/store/discount/route";
import { POST as checkoutRoute } from "@/app/api/store/checkout/route";
import { SESSION_COOKIE, openSession } from "@/lib/auth";
import { codeCookieName } from "@/lib/code-link";
import { confirmPurchase } from "@/lib/purchase-email";
import { readOrder } from "@/lib/store-checkout";
import { addProduct, claimHandle, ensureStatsId, setProductLink, setStripeAccount, setSubscription, storeForEmail } from "@/lib/store";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";
import { paidPeriod } from "./billing-period-fixture";
import { withConsent } from "./digital-consent-fixture";

const OWNER = "orchard@example.com";
const HANDLE = "orchardpress";
const ACCOUNT = "acct_1TestOrchard001";

type Promo = { id: string; code: string; coupon: Record<string, unknown>; active: boolean; max_redemptions: number | null; times_redeemed: number };
const coupons: Record<string, unknown>[] = [];
const promos: Promo[] = [];
const opened: { id: string; body: URLSearchParams; account: string | null }[] = [];
const sessions = new Map<string, Record<string, unknown>>();
const emails: { to: string[]; subject: string; text: string }[] = [];
/** As Stripe answers: the payment is only its id unless the request expanded it. */
const asAsked = (session: Record<string, unknown>, url: URL) => {
  const pi = session.payment_intent as { id?: string } | string | undefined;
  const expanded = url.searchParams.getAll("expand[]").some((field) => field.startsWith("payment_intent"));
  return pi && typeof pi === "object" && !expanded ? { ...session, payment_intent: pi.id } : session;
};
const answer = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
const promoRow = (promo: Promo) => ({ object: "promotion_code", id: promo.id, code: promo.code, active: promo.active, max_redemptions: promo.max_redemptions, times_redeemed: promo.times_redeemed, promotion: { type: "coupon", coupon: promo.coupon }, restrictions: {} });

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
  if (url.pathname === "/v1/coupons" && method === "POST") {
    const coupon = { object: "coupon", id: `coupon_${coupons.length + 1}`, duration: sent.get("duration"), percent_off: Number(sent.get("percent_off")) || null, amount_off: Number(sent.get("amount_off")) || null, currency: sent.get("currency"), name: sent.get("name"), account };
    coupons.push(coupon);
    return answer(coupon);
  }
  if (url.pathname === "/v1/promotion_codes" && method === "POST") {
    const coupon = coupons.find((entry) => entry.id === sent.get("promotion[coupon]"));
    if (!coupon) return answer({ error: { message: "No such coupon" } }, 400);
    const promo: Promo = { id: `promo_1TestOrchard${promos.length + 1}`, code: sent.get("code") ?? "", coupon, active: sent.get("active") !== "false", max_redemptions: sent.has("max_redemptions") ? Number(sent.get("max_redemptions")) : null, times_redeemed: 0 };
    promos.push(promo);
    return answer(promoRow(promo));
  }
  if (url.pathname === "/v1/promotion_codes" && method === "GET") {
    const code = url.searchParams.get("code");
    const rows = promos.filter((promo) => (!code || promo.code === code) && (url.searchParams.get("active") !== "true" || promo.active));
    return answer({ object: "list", data: rows.map(promoRow), has_more: false });
  }
  const promoOne = /^\/v1\/promotion_codes\/([^/]+)$/.exec(url.pathname);
  if (promoOne && method === "POST") {
    const promo = promos.find((entry) => entry.id === decodeURIComponent(promoOne[1]));
    if (!promo) return answer({ error: { message: "No such promotion code" } }, 404);
    if (sent.has("active")) promo.active = sent.get("active") === "true";
    return answer(promoRow(promo));
  }
  if (url.pathname === "/v1/checkout/sessions" && method === "POST") {
    // Stripe applies a promotion code only while it can still be redeemed.
    const applied = sent.get("discounts[0][promotion_code]");
    if (applied) {
      const promo = promos.find((entry) => entry.id === applied);
      if (!promo || !promo.active || (promo.max_redemptions !== null && promo.times_redeemed >= promo.max_redemptions)) {
        return answer({ error: { type: "invalid_request_error", message: "This promotion code cannot be redeemed because the associated coupon is no longer valid." } }, 400);
      }
    }
    const id = `cs_test_journeycode${String(opened.length + 1).padStart(6, "0")}`;
    opened.push({ id, body: sent, account });
    sessions.set(id, { id, object: "checkout.session", status: "open", payment_status: "unpaid" });
    return answer({ id, url: `https://checkout.stripe.com/c/pay/${id}` });
  }
  const one = /^\/v1\/checkout\/sessions\/([^/]+)$/.exec(url.pathname);
  if (one && method === "GET") {
    const found = sessions.get(decodeURIComponent(one[1]));
    return found ? answer(asAsked(found, url)) : answer({ error: { message: "No such checkout.session" } }, 404);
  }
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

/** Stripe takes the payment, with the promotion code the checkout was opened with, and counts its use. */
function stripePays(id: string, email: string): number {
  const made = opened.find((entry) => entry.id === id);
  if (!made) throw new Error(`no checkout ${id}`);
  const subtotal = Number(made.body.get("line_items[0][price_data][unit_amount]")) * Number(made.body.get("line_items[0][quantity]") ?? "1");
  const promo = promos.find((entry) => entry.id === made.body.get("discounts[0][promotion_code]")) ?? null;
  const percent = promo ? Number(promo.coupon.percent_off) : 0;
  const discount = Math.round((subtotal * percent) / 100);
  if (promo) promo.times_redeemed += 1;
  const total = subtotal - discount;
  sessions.set(id, {
    id,
    object: "checkout.session",
    status: "complete",
    payment_status: "paid",
    mode: made.body.get("mode"),
    currency: made.body.get("line_items[0][price_data][currency]"),
    amount_subtotal: subtotal,
    amount_total: total,
    total_details: { amount_discount: discount, amount_shipping: 0, amount_tax: 0 },
    discounts: promo ? [{ coupon: promo.coupon, promotion_code: promo.id }] : [],
    created: Math.floor(Date.now() / 1000),
    customer_details: { email },
    metadata: metadataOf(made.body),
    payment_intent: {
      id: `pi_test_journeycode${id.slice(-6)}`,
      object: "payment_intent",
      status: "succeeded",
      latest_charge: { id: `ch_test_journeycode${id.slice(-6)}`, object: "charge", amount: total, amount_refunded: 0, refunded: false, disputed: false },
      payment_method: { type: "card" },
    },
  });
  return total;
}

async function main(): Promise<void> {
  redis.clear();
  process.env.STRIPE_SECRET_KEY = "sk_test_journey_code_only";
  process.env.RESEND_API_KEY = "re_test_a_stand_in_key_for_tests_only";

  await claimHandle(OWNER, HANDLE, "Orchard Press", "");
  await ensureStatsId(OWNER);
  await setStripeAccount(OWNER, ACCOUNT, true);
  await setSubscription(OWNER, { customerId: "cus_Orchard0001", subscriptionId: "sub_Orchard0001", active: true, period: paidPeriod() });
  const made = await addProduct(OWNER, "Pressing Handbook", "", "49", null);
  if (!made.ok) throw new Error("no product");
  const product = made.product.id;
  await setProductLink(OWNER, product, "https://example.com/handbook");
  const store = async () => (await storeForEmail(OWNER))!;
  const signedIn = `${SESSION_COOKIE}=${await openSession(OWNER)}`;
  const studio = async (body: Record<string, unknown>) => {
    const response = await discountRoute(
      new NextRequest("https://marktmorgen.com/api/store/discount", {
        method: "POST",
        headers: { host: "marktmorgen.com", origin: "https://marktmorgen.com", "content-type": "application/json", cookie: signedIn },
        body: JSON.stringify(body),
      }),
    );
    return { status: response.status, body: (await response.json()) as Record<string, unknown> };
  };
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
  const fromLink = `${codeCookieName(HANDLE)}=SPRING`;

  part("1. The creator makes the code in the studio");
  is("before any code, the store offers no box", (await store()).hasDiscounts, false);
  const add = await studio({ action: "add", code: "spring", kind: "percent", percent: "25", uses: "1" });
  is("the studio accepts it", [add.status, add.body.ok], [200, true]);
  is("one coupon, once, 25% off, on the creator's own account", coupons.map((coupon) => [coupon.duration, coupon.percent_off, coupon.account]), [["once", 25, ACCOUNT]]);
  is("one promotion code SPRING pointing at it, good for one use", promos.map((promo) => [promo.code, promo.coupon.id, promo.max_redemptions, promo.active]), [["SPRING", "coupon_1", 1, true]]);
  is("the store now offers a code box", (await store()).hasDiscounts, true);

  part("2. A buyer with no code");
  const plain = await buy();
  is("sent to Stripe, one checkout", [plain.stripe, plain.made.length], [true, 1]);
  is("the box on Stripe's page, nothing applied, at the full price", [plain.made[0].body.get("allow_promotion_codes"), plain.made[0].body.get("discounts[0][promotion_code]"), plain.made[0].body.get("line_items[0][price_data][unit_amount]")], ["true", null, "4900"]);

  part("3. A buyer who came through the link with the code");
  const coded = await buy(fromLink);
  const checkout = coded.made[0];
  is("sent to Stripe, on the creator's account", [coded.stripe, checkout.account], [true, ACCOUNT]);
  is("the code goes on by itself, by the creator's own promotion code, and the order says which", [checkout.body.get("discounts[0][promotion_code]"), checkout.body.get("allow_promotion_codes"), metadataOf(checkout.body).code], [promos[0].id, null, "SPRING"]);
  is("the line is still the product's price; Stripe takes the code off it", checkout.body.get("line_items[0][price_data][unit_amount]"), "4900");

  part("4. Paid with the discount");
  is("Stripe charged $36.75", stripePays(checkout.id, "reader@example.com"), 3675);
  const order = await readOrder(await store(), checkout.id);
  if (order.state !== "paid") throw new Error(`the paid order reads as ${order.state}`);
  is("the order is paid for $36.75, and hands over the handbook", [order.amount, order.product.id, order.link], [3675, product, "https://example.com/handbook"]);
  is("the confirmation is sent", await confirmPurchase(await store(), checkout.id), "sent");
  const mine = emails.filter((email) => email.to.includes("reader@example.com"));
  is("one email to the buyer, naming the handbook", [mine.length, mine[0]?.text.includes("Pressing Handbook")], [1, true]);
  is("it says what was paid: the discounted $36.75, never the $49 list price", (mine[0]?.text ?? "").split("\n").find((line) => line.startsWith("Paid:")), "Paid: $36.75");
  is("a second try sends nothing more", [await confirmPurchase(await store(), checkout.id), emails.filter((email) => email.to.includes("reader@example.com")).length], ["already", 1]);

  part("5. The code used up: the next buyer is never turned away");
  const usedUp = await buy(fromLink);
  is("Stripe refused the code, and the checkout still opened, with the box", [usedUp.stripe, usedUp.made.length, usedUp.made[0]?.body.get("discounts[0][promotion_code]"), usedUp.made[0]?.body.get("allow_promotion_codes"), metadataOf(usedUp.made[0]?.body ?? new URLSearchParams()).code], [true, 1, null, "true", undefined]);
  is("at the full price", usedUp.made[0]?.body.get("line_items[0][price_data][unit_amount]"), "4900");

  part("6. The creator stops the code");
  promos[0].times_redeemed = 0;
  const stop = await studio({ action: "stop", id: promos[0].id });
  is("the studio stops it at Stripe", [stop.status, stop.body.ok, promos[0].active], [200, true, false]);
  const after = await buy(fromLink);
  is("with no live code left, the store offers no box any more", (await store()).hasDiscounts, false);
  is("the next buyer with the link: nothing applied, no box, the full price", [after.stripe, after.made[0]?.body.get("discounts[0][promotion_code]"), after.made[0]?.body.get("allow_promotion_codes"), after.made[0]?.body.get("line_items[0][price_data][unit_amount]")], [true, null, null, "4900"]);
  const list = await studio({ action: "list" });
  const codes = (list.body.codes ?? []) as { code: string; active: boolean; timesRedeemed: number }[];
  is("the studio lists it as off", codes.map((code) => [code.code, code.active]), [["SPRING", false]]);

  done();
}

void main();
