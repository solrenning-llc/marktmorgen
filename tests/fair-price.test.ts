/**
 * Fair prices by country (lib/fair-price.ts, added 8 October 2026).
 *
 * Measured that day: Gumroad has it built in ("purchasing power parity");
 * Kajabi only through an outside app. What is checked:
 *
 *   - it is off on every store until its creator switches it on, and a
 *     setting saved from anything else is read safely;
 *   - automatic: the World Bank's price level makes the percentage, in steps
 *     of five rounded down, never past the creator's most or 60%; nothing
 *     above 80% of US prices, and nothing for the high-income list;
 *   - the creator's own level for a country wins, none included; with
 *     automatic off, only the listed countries get anything;
 *   - it covers what a sale covers, and the page takes the larger of a sale
 *     and a fair price, never both; the creator can limit it to the
 *     products they pick, and a setting saved before that covers every one;
 *   - at checkout: the coupon is made once on the creator's account, at the
 *     percentage the page showed, written on the order, and the sale's
 *     coupon is used instead when it takes off more; no country, no plan, a
 *     membership, or a store with it off: nothing.
 */
import { TEST_CONSENT } from "./digital-consent-fixture";
import { DEFAULT_FAIR, countryOff, fairCouponId, fairOff, parseFair, readCountry, storeCountryOff } from "@/lib/fair-price";
import { PRICE_LEVELS } from "@/lib/fair-price-data";
import { addProduct, claimHandle, ensureStatsId, setFair, setProductExtras, setProductLink, setStripeAccount, setSubscription, storeForEmail } from "@/lib/store";
import { readProduct } from "@/lib/catalog";
import { createCheckout } from "@/lib/store-checkout";
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
    return answer({ id: `cs_test_${"f".repeat(24)}`, url: "https://checkout.stripe.com/c/pay/test" });
  }
  if (path === "/coupons" && method === "POST") {
    const body = new URLSearchParams(String(init?.body));
    coupons.push(body);
    return answer({ id: body.get("id"), percent_off: Number(body.get("percent_off")) });
  }
  // A coupon made here is there when it is checked (lib/coupon-check.ts, #4377); the latest one made under its id.
  const coupon = /^\/coupons\/(.+)$/.exec(path);
  if (coupon && method === "GET") {
    const id = decodeURIComponent(coupon[1]);
    const made = [...coupons].reverse().find((body) => body.get("id") === id);
    return made ? answer({ id, valid: true, percent_off: Number(made.get("percent_off")), duration: made.get("duration") }) : answer({ error: { code: "resource_missing", message: "No such coupon" } }, 404);
  }
  if (method === "GET") return answer({ object: "list", data: [], has_more: false });
  return answer({ error: { message: `no stand-in for ${method} ${path}` } }, 404);
}) as typeof fetch;

const product = (over: Record<string, unknown> = {}) => ({ id: "p1", priceCents: 2700, recurring: null, call: null, pwyw: null, options: [], ...over });
const on = (over: Partial<typeof DEFAULT_FAIR> = {}) => ({ ...DEFAULT_FAIR, on: true, ...over });

async function main(): Promise<void> {
  redis.clear();
  process.env.STRIPE_SECRET_KEY = "sk_test_fair_only_a_stand_in";

  part("Off until the creator switches it on");
  is("a new store has it off", [DEFAULT_FAIR.on, storeCountryOff(DEFAULT_FAIR, "IN")], [false, 0]);
  is("anything else stored is read as off", [parseFair(null), parseFair("on"), parseFair({ on: "yes" }).on], [DEFAULT_FAIR, DEFAULT_FAIR, false]);
  is("a level that is not one of the choices is dropped", parseFair({ on: true, levels: { IN: 33, BR: 50, br: 20, XXX: 10 } }).levels, { BR: 50 });
  is("the country a request carries", [readCountry("in"), readCountry(" BR "), readCountry("Brazil"), readCountry(null)], ["IN", "BR", "", ""]);

  part("Automatic");
  is("the data has the countries it should", [PRICE_LEVELS.IN, PRICE_LEVELS.BR, PRICE_LEVELS.US], [0.24, 0.46, 1]);
  is("India: 76% suggested, so the most allowed", [countryOff("IN", 50), countryOff("IN", 60)], [50, 60]);
  is("Brazil: 0.46 is 54%, rounded down to 50", countryOff("BR", 60), 50);
  is("Mexico: 0.54 is 46%, rounded down to 45", countryOff("MX", 60), 45);
  is("the high-income list gets nothing, whatever its prices", [countryOff("JP", 60), countryOff("ES", 60), countryOff("US", 60), countryOff("DE", 60)], [0, 0, 0, 0]);
  is("nothing above 80% of US prices", countryOff("BS", 60), 0);
  is("a country without numbers gets nothing", countryOff("ZZ", 60), 0);

  part("The creator's countries and levels");
  const mine = on({ levels: { IN: 30, BR: 0, US: 20 } });
  is("their level wins over the suggestion, none included", [storeCountryOff(mine, "IN"), storeCountryOff(mine, "BR")], [30, 0]);
  is("they can even lower it where the suggestion never would", storeCountryOff(mine, "US"), 20);
  is("other countries keep the suggestion", storeCountryOff(mine, "MX"), 45);
  const listed = on({ auto: false, levels: { IN: 70, PH: 40 } });
  is("only listed countries, at their own levels", [storeCountryOff(listed, "IN"), storeCountryOff(listed, "PH"), storeCountryOff(listed, "MX")], [70, 40, 0]);

  part("What it covers");
  is("a product bought once at one price", fairOff(on(), product(), "IN"), 50);
  is("not a membership, a call, a price the buyer names or price options", [
    fairOff(on(), product({ recurring: { interval: "month" } }), "IN"),
    fairOff(on(), product({ call: {} }), "IN"),
    fairOff(on(), product({ pwyw: { suggestedCents: 100 } }), "IN"),
    fairOff(on(), product({ options: [{}] }), "IN"),
  ], [0, 0, 0, 0]);
  is("no country, nothing", fairOff(on(), product(), ""), 0);
  const picked = on({ all: false, products: ["p1"] });
  is("only the products picked: one picked gets it, another does not", [fairOff(picked, product(), "IN"), fairOff(picked, product({ id: "p2" }), "IN")], [50, 0]);
  is("only the products picked, none picked: nothing anywhere", fairOff(on({ all: false, products: [] }), product(), "IN"), 0);
  is("a setting saved before products could be picked covers every one", [parseFair({ on: true }).all, parseFair({ on: true }).products], [true, []]);
  is("product ids are kept clean and once each", parseFair({ on: true, all: false, products: ["p1", "p1", "bad id", 7, "p_2"] }).products, ["p1", "p_2"]);
  is("a picked product that cannot have one still does not", fairOff(picked, product({ recurring: { interval: "month" } }), "IN"), 0);

  part("At checkout");
  await claimHandle(OWNER, "harbor", "Harbor Kitchen", "");
  await ensureStatsId(OWNER);
  await setStripeAccount(OWNER, "acct_1TestHarbor0001", true);
  await setSubscription(OWNER, { customerId: "cus_Owner00001", subscriptionId: "sub_Owner00001", active: true, period: paidPeriod() });
  const made = await addProduct(OWNER, "Meal Planner", "", "27", null);
  if (!made.ok) throw new Error("no product");
  await setProductLink(OWNER, made.product.id, "https://example.com/planner");
  const open = async (country: string, more: Parameters<typeof createCheckout>[4] = {}) => {
    checkouts.length = 0;
    const store = (await storeForEmail(OWNER))!;
    await createCheckout(store, (await readProduct(store, made.product.id))!, "https://marktmorgen.com", "", { country, ...more, digitalConsent: TEST_CONSENT });
    return checkouts[0];
  };
  let sent = await open("IN");
  is("off on the store: nothing taken off", [sent.get("discounts[0][coupon]"), sent.get("metadata[fair]")], [null, null]);

  await setFair(OWNER, { on: true, auto: true, maxOff: 50, levels: { MX: 30 } });
  sent = await open("IN");
  is("on: the fair price comes off with the creator's own coupon", [sent.get("discounts[0][coupon]"), sent.get("metadata[fair]")], [fairCouponId(50), "IN:50"]);
  is("made on their account once, named for the buyer", [coupons.length, coupons[0]?.get("id"), coupons[0]?.get("percent_off"), coupons[0]?.get("duration"), coupons[0]?.get("name")], [1, "mm_fair_50", "50", "once", "Fair price for your country"]);
  await open("IN");
  is("the second checkout at that level makes no other", coupons.length, 1);
  sent = await open("MX");
  is("the creator's own level for Mexico", sent.get("metadata[fair]"), "MX:30");
  sent = await open("US");
  is("a country it does not cover pays the normal price, and may type a code", [sent.get("discounts[0][coupon]"), sent.get("metadata[fair]")], [null, null]);
  await setFair(OWNER, { on: true, auto: true, maxOff: 50, levels: { MX: 30 }, all: false, products: ["someone_else"] });
  sent = await open("IN");
  is("a product the creator did not pick pays the normal price", [sent.get("discounts[0][coupon]"), sent.get("metadata[fair]")], [null, null]);
  await setFair(OWNER, { on: true, auto: true, maxOff: 50, levels: { MX: 30 }, all: false, products: [made.product.id] });
  sent = await open("IN");
  is("a product they picked gets it", sent.get("metadata[fair]"), "IN:50");
  sent = await open("", {});
  is("no country known: the normal price", sent.get("metadata[fair]"), null);
  await setProductExtras(OWNER, made.product.id, { plan: { payments: 3, interval: "month", amountCents: 1000 } });
  sent = await open("IN", { plan: true });
  is("a payment plan is never lowered (the page says the lower price is for paying in full)", sent.get("metadata[fair]"), null);

  done();
}

void main();
