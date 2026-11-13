/**
 * A membership's introductory price (lib/intro-price.ts, added 10 October
 * 2026). What is checked:
 *
 *   - what is stored or sent is read safely, and kept only on a membership
 *     that runs until canceled, at one price, without a free trial, outside
 *     the plans members switch between, below the regular price and at least
 *     what the currency can charge, for 1 to 12 months of a monthly
 *     membership or the first payment of any other;
 *   - a product changed after it was set stops offering it, everywhere;
 *   - it is said in every store language, before the regular price;
 *   - at checkout: a coupon for the difference, made once on the creator's
 *     account, for the first payment or that many months, the order says
 *     what it was, and a come-back offer replaces it;
 *   - the confirmation says both prices.
 */
import { TEST_CONSENT } from "./digital-consent-fixture";
import { MAX_INTRO_COUNT, activeIntro, introCouponId, introLineEnglish, introProblem, parseIntro } from "@/lib/intro-price";
import { membershipLine } from "@/lib/buyer-words";
import { LANGUAGE_CODES } from "@/lib/store-language";
import { addProduct, claimHandle, ensureStatsId, setProductIntro, setProductLink, setStoreTiers, setStripeAccount, setSubscription, storeForEmail } from "@/lib/store";
import { readProduct } from "@/lib/catalog";
import { createCheckout } from "@/lib/store-checkout";
import { introOf } from "@/lib/purchase-email";
import { canTier } from "@/lib/tier-rules";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";
import { paidPeriod } from "./billing-period-fixture";

const OWNER = "owner@example.com";
const checkouts: URLSearchParams[] = [];
const coupons: URLSearchParams[] = [];
globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const url = new URL(String(input));
  const path = url.pathname.replace(/^\/v1/, "");
  const method = init?.method ?? "GET";
  const answer = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
  if (path === "/checkout/sessions" && method === "POST") {
    checkouts.push(new URLSearchParams(String(init?.body)));
    return answer({ id: `cs_test_${"i".repeat(24)}`, url: "https://checkout.stripe.com/c/pay/test" });
  }
  if (path === "/coupons" && method === "POST") {
    const body = new URLSearchParams(String(init?.body));
    coupons.push(body);
    return answer({ id: body.get("id"), amount_off: Number(body.get("amount_off")) });
  }
  // A coupon made here is there when it is checked (lib/coupon-check.ts, #4377); the latest one made under its id.
  const coupon = /^\/coupons\/(.+)$/.exec(path);
  if (coupon && method === "GET") {
    const id = decodeURIComponent(coupon[1]);
    const made = [...coupons].reverse().find((body) => body.get("id") === id);
    return made ? answer({ id, valid: true, amount_off: Number(made.get("amount_off")), currency: made.get("currency"), duration: made.get("duration"), duration_in_months: Number(made.get("duration_in_months")) || undefined }) : answer({ error: { code: "resource_missing", message: "No such coupon" } }, 404);
  }
  if (method === "GET") return answer({ object: "list", data: [], has_more: false });
  return answer({ error: { message: `no stand-in for ${method} ${path}` } }, 404);
}) as typeof fetch;

const monthly = { interval: "month" as const, trialDays: 0, payments: 0 };
const member = (over: Record<string, unknown> = {}) => ({ id: "p1", priceCents: 2000, recurring: monthly, options: [] as unknown[], pwyw: null, ...over });

async function main(): Promise<void> {
  redis.clear();
  process.env.STRIPE_SECRET_KEY = "sk_test_intro_only_a_stand_in";

  part("Read safely");
  is("a price and a count", parseIntro({ cents: 500, count: 3 }), { cents: 500, count: 3 });
  is("nothing else is one", [parseIntro(null), parseIntro({ cents: 0, count: 1 }), parseIntro({ cents: 500, count: 0 }), parseIntro({ cents: 500, count: MAX_INTRO_COUNT + 1 }), parseIntro({ cents: 5.5, count: 1 })], [null, null, null, null, null]);

  part("Only where it can be kept");
  const intro = { cents: 500, count: 1 };
  is("a monthly membership that runs until canceled", introProblem(member(), intro, 50), null);
  is("not a single sale", introProblem(member({ recurring: null }), intro, 50), "membership");
  is("not beside a free trial", introProblem(member({ recurring: { ...monthly, trialDays: 7 } }), intro, 50), "trial");
  is("not on a set number of payments", introProblem(member({ recurring: { ...monthly, payments: 12 } }), intro, 50), "payments");
  is("not with several prices", introProblem(member({ options: [{}] }), intro, 50), "options");
  is("not where the buyer chooses the price", introProblem(member({ pwyw: { suggestedCents: 900 } }), intro, 50), "pwyw");
  is("not on plans members switch between", introProblem(member(), intro, 50, ["p1", "p2"]), "tiers");
  is("below the regular price, never at it or above", [introProblem(member(), { cents: 2000, count: 1 }, 50), introProblem(member(), { cents: 2500, count: 1 }, 50)], ["price", "price"]);
  is("and at least what the currency can charge", introProblem(member(), { cents: 30, count: 1 }, 50), "price");
  is("1 to 12 months of a monthly membership", [introProblem(member(), { cents: 500, count: 12 }, 50), introProblem(member(), { cents: 500, count: 13 }, 50)], [null, "count"]);
  is("only the first payment of any other", [introProblem(member({ recurring: { ...monthly, interval: "year" } }), { cents: 500, count: 1 }, 50), introProblem(member({ recurring: { ...monthly, interval: "week" } }), { cents: 500, count: 2 }, 50)], [null, "count"]);
  is("a membership with one cannot be a plan members switch between", [canTier(member()), canTier(member({ intro }))], [true, false]);

  part("Offered only while it can be");
  is("as set", activeIntro(member({ intro })), intro);
  is("the price lowered to it: none", activeIntro(member({ intro, priceCents: 500 })), null);
  is("a trial added: none", activeIntro(member({ intro, recurring: { ...monthly, trialDays: 7 } })), null);
  is("made a plan members switch between: none", activeIntro(member({ intro }), ["p1", "p2"]), null);

  part("Said before anybody pays");
  const said = (language: string, count = 1, interval: "month" | "year" = "month") =>
    membershipLine({ language, currency: "usd" }, { ...monthly, interval }, "$20", { cents: 500, count });
  const plain = (line: string) => line.replace(/[\u00a0\u202f]/g, " ");
  is("in English", [said("en"), said("en", 3), said("en", 1, "year")], ["$5 the first month, then $20 a month", "$5 a month for the first 3 months, then $20 a month", "$5 the first year, then $20 a year"]);
  is("and for the studio and answers, the same way", introLineEnglish("$5", 3, "month", "$20 a month"), "$5 a month for the first 3 months, then $20 a month");
  const lines = LANGUAGE_CODES.map((language) => said(language, 3));
  is("in every store language, each its own words", new Set(lines).size, LANGUAGE_CODES.length);
  is("each with both prices", lines.every((line) => line.includes("20") && line.includes("5") && line.includes("3")), true);
  is("German, Spanish and Portuguese, read", [said("de"), said("es", 3), said("pt")].map(plain), ["5 $ im ersten Monat, danach $20 pro Monat", "5 US$ al mes durante los primeros 3 meses, luego $20 al mes", "5 US$ no primeiro mês, depois $20 por mês"]);

  part("At checkout");
  await claimHandle(OWNER, "harbor", "Harbor Kitchen", "");
  await ensureStatsId(OWNER);
  await setStripeAccount(OWNER, "acct_1TestHarbor0001", true);
  await setSubscription(OWNER, { customerId: "cus_Owner00001", subscriptionId: "sub_Owner00001", active: true, period: paidPeriod() });
  const made = await addProduct(OWNER, "Supper Club", "", "20", monthly);
  if (!made.ok) throw new Error("no product");
  await setProductLink(OWNER, made.product.id, "https://example.com/club");
  is("refused on the product when it cannot be kept", (await setProductIntro(OWNER, made.product.id, { cents: 2500, count: 1 })).ok ? "kept" : "refused", "refused");
  const set = await setProductIntro(OWNER, made.product.id, { cents: 500, count: 3 });
  is("kept on the product when it can", set.ok ? set.product.intro : null, { cents: 500, count: 3 });
  const open = async (more: Parameters<typeof createCheckout>[4] = {}) => {
    checkouts.length = 0;
    const store = (await storeForEmail(OWNER))!;
    await createCheckout(store, (await readProduct(store, made.product.id))!, "https://marktmorgen.com", "", { ...more, digitalConsent: TEST_CONSENT });
    return checkouts[0];
  };
  let sent = await open();
  is("the regular price is the price, and a coupon takes the difference off", [sent.get("line_items[0][price_data][unit_amount]"), sent.get("discounts[0][coupon]")], ["2000", introCouponId("usd", 1500, 3)]);
  is("the coupon: that much off, for the first 3 months, made on the creator's account", [coupons.length, coupons[0]?.get("amount_off"), coupons[0]?.get("currency"), coupons[0]?.get("duration"), coupons[0]?.get("duration_in_months")], [1, "1500", "usd", "repeating", "3"]);
  is("the order says what it was", [sent.get("metadata[intro]"), sent.get("metadata[intro_cents]"), sent.get("metadata[regular_cents]")], ["3", "500", "2000"]);
  is("and no code box beside it: one discount at a time", sent.get("allow_promotion_codes"), null);
  await open();
  is("made once, and used again", coupons.length, 1);
  sent = await open({ coupon: "winback_coupon_1", noTrial: true });
  is("a come-back offer replaces it", [sent.get("discounts[0][coupon]"), sent.get("metadata[intro]")], ["winback_coupon_1", null]);
  is("one month: the first payment only", (await setProductIntro(OWNER, made.product.id, { cents: 900, count: 1 })).ok, true);
  coupons.length = 0;
  sent = await open();
  is("so the coupon is once, for the difference", [coupons[0]?.get("duration"), coupons[0]?.get("amount_off"), coupons[0]?.get("duration_in_months")], ["once", "1100", null]);
  is("taken off, nothing is offered", (await setProductIntro(OWNER, made.product.id, null)).ok, true);
  sent = await open();
  is("and the checkout is the regular one", [sent.get("discounts[0][coupon]"), sent.get("metadata[intro]")], [null, null]);
  await setProductIntro(OWNER, made.product.id, { cents: 500, count: 3 });
  const other = await addProduct(OWNER, "Supper Club Plus", "", "40", monthly);
  if (!other.ok) throw new Error("no product");
  await setStoreTiers(OWNER, [made.product.id, other.product.id]);
  sent = await open();
  is("a plan members switch between: not offered, even if it was set before", [sent.get("discounts[0][coupon]"), sent.get("metadata[intro]")], [null, null]);
  is("and it cannot be set on one", (await setProductIntro(OWNER, other.product.id, { cents: 500, count: 1 })).ok, false);

  part("The confirmation says both prices");
  is("read from the order", introOf({ intro: "3", intro_cents: "500", regular_cents: "2000" }), { cents: 500, count: 3, regular: 2000 });
  is("an order without one has none", [introOf({}), introOf({ intro: "3", intro_cents: "500" })], [null, null]);

  done();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
