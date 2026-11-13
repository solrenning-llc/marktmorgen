/**
 * Mutation testing of createCheckout's amounts and retries (lib/store-checkout.ts;
 * Claude 7, 13/11/2026): each case kills a mutant that survived the 38 tests
 * importing the module. A store sale never comes off a payment plan, a group
 * purchase over the most one checkout may charge is refused, the buyer's price
 * goes to Stripe as the creator's choose-your-price Price alone, a reminder's
 * checkout closes an hour from now, and a refusal is put right only for the
 * reason Stripe gave: a code from a link that does not fit opens with the box,
 * an archived choose-your-price Price is made again once, a refused tax box is
 * dropped; anything else is not retried.
 *
 * Synthetic only: Stripe is a stand-in fetch and Redis is tests/redis-stub.ts.
 */
import { TEST_CONSENT } from "./digital-consent-fixture";
import { addProduct, claimHandle, ensureStatsId, setProductLink, setStoreSale, setStripeAccount, setSubscription, storeForEmail, type Store } from "@/lib/store";
import { readProduct } from "@/lib/catalog";
import { createCheckout } from "@/lib/store-checkout";
import { parseSale } from "@/lib/store-sale";
import { shippingWords } from "@/lib/buyer-words/shipping";
import { RECOVERY_OPEN_SECONDS } from "@/lib/recovery-setting";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";
import { paidPeriod } from "./billing-period-fixture";

type Answer = { status: number; body: unknown };
const OK: Answer = { status: 200, body: { id: `cs_test_${"m".repeat(24)}`, url: "https://checkout.stripe.com/c/pay/test" } };
let checkouts: URLSearchParams[] = [];
let answers: Answer[] = [];
let prices = 0;
globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const url = new URL(String(input));
  const path = url.pathname.replace(/^\/v1/, "");
  const method = init?.method ?? "GET";
  if (path === "/checkout/sessions" && method === "POST") {
    checkouts.push(new URLSearchParams(String(init?.body)));
    const answer = answers.shift() ?? OK;
    return new Response(JSON.stringify(answer.body), { status: answer.status });
  }
  if (path === "/prices" && method === "POST") {
    prices += 1;
    return new Response(JSON.stringify({ id: `price_mutpwyw${prices}`, object: "price" }));
  }
  if (path === "/promotion_codes") return new Response(JSON.stringify({ object: "list", data: [{ id: "promo_mutlink1", code: "LINK10", active: true }], has_more: false }));
  return new Response("{}", { status: 404 });
}) as typeof fetch;

const refusal = (status: number, code: string, message: string): Answer => ({ status, body: { error: { code, message } } });
const outcome = async (run: () => Promise<unknown>): Promise<string> => {
  try {
    await run();
    return "opened";
  } catch (error) {
    // Stripe's own sentence when Stripe refused (lib/stripe-account.ts StripeError), else the error's.
    const said = (error as { stripeMessage?: string }).stripeMessage ?? (error instanceof Error ? error.message : "");
    return `refused: ${said.slice(0, 60)}`;
  }
};

async function main(): Promise<void> {
  redis.clear();
  process.env.STRIPE_SECRET_KEY = "sk_test_checkout_mutants_stand_in";
  await claimHandle("owner@example.com", "harbor", "Harbor Kitchen", "");
  await ensureStatsId("owner@example.com");
  await setStripeAccount("owner@example.com", "acct_1TestHarbor0001", true);
  await setSubscription("owner@example.com", { customerId: "cus_Owner00001", subscriptionId: "sub_Owner00001", active: true, period: paidPeriod() });
  const made = await addProduct("owner@example.com", "Bread Book", "", "49", null);
  if (!made.ok) throw new Error("no product");
  await setProductLink("owner@example.com", made.product.id, "https://example.com/bread");
  const real = Math.floor(Date.now() / 1000);
  await setStoreSale("owner@example.com", parseSale({ name: "Black Friday", percent: 30, starts: real - 60, ends: real + 3_600, all: true, products: [], coupon: "co_Sale0001" }));
  const store = (await storeForEmail("owner@example.com"))!;
  const full = (await readProduct(store, made.product.id))!;
  const open = (s: Store, p: typeof full, extras: Parameters<typeof createCheckout>[4] = {}) => {
    checkouts = [];
    return createCheckout(s, p, "https://marktmorgen.com", "", { digitalConsent: TEST_CONSENT, ...extras });
  };
  const last = () => checkouts[checkouts.length - 1];

  part("A store sale and a payment plan");
  const planned = { ...full, plan: { payments: 3, interval: "month", amountCents: 1_700 } } as typeof full;
  await open(store, planned, { plan: true });
  is("the plan is charged in full payments, with no sale off", [last().get("line_items[0][price_data][unit_amount]"), last().get("discounts[0][coupon]"), last().get("metadata[sale]")], ["1700", null, null]);
  await open({ ...store, affiliates: { ...store.affiliates, recurring: 12 } } as Store, planned, { plan: true, via: { aff: "0123456789ab", rate: 20 } });
  const viaAt = last().get("subscription_data[metadata][via_at]") ?? "";
  is("the affiliate's start on a plan is a whole second", /^\d+$/.test(viaAt) && Math.abs(Number(viaAt) - Math.floor(Date.now() / 1000)) <= 5, true);

  await open({ ...store, hasDiscounts: true } as Store, planned, { plan: true, coupon: "co_welcome", welcome: true });
  is("a welcome offer on a plan is how its subscription began", last().get("subscription_data[metadata][discount]"), "welcome");
  await open({ ...store, hasDiscounts: true, sale: { ...store.sale, percent: 0 } } as Store, planned, { plan: true, code: "LINK10" });
  is("so is a code from a link", [last().get("discounts[0][promotion_code]"), last().get("subscription_data[metadata][discount]")], ["promo_mutlink1", "code"]);

  part("For several people");
  is("over the most one checkout may charge: refused", await outcome(() => open(store, full, { group: { id: "grp_mutants", people: 20_000 } })), "refused: This cannot be bought for several people");

  part("Shipping");
  const shipped = (cents: number) => ({ ...full, link: null, shipping: { cents, region: "custom", countries: ["US"], note: "" } }) as unknown as typeof full;
  await open(store, shipped(0));
  is("free shipping is named free", last().get("shipping_options[0][shipping_rate_data][display_name]"), shippingWords(store.language).freeRate);

  part("The buyer names the price");
  const named = { ...full, pwyw: { suggestedCents: 6_000 } } as typeof full;
  await open(store, named);
  is("the creator's choose-your-price Price alone", [last().get("line_items[0][price]")?.startsWith("price_mutpwyw"), [...last().keys()].some((k) => k.startsWith("line_items[0][price_data]"))], [true, false]);

  part("A reminder's checkout");
  const before = Math.floor(Date.now() / 1000);
  await open(store, full, { remind: true });
  const closes = Number(last().get("expires_at"));
  is("closes an hour from now, in whole seconds", Number.isInteger(closes) && closes >= before + RECOVERY_OPEN_SECONDS && closes <= Math.floor(Date.now() / 1000) + RECOVERY_OPEN_SECONDS, true);
  await open(store, full);
  is("no reminder, no closing time of ours", last().get("expires_at"), null);

  part("Refusals put right only for their reason");
  const noSale = { ...store, sale: { ...store.sale, percent: 0 } } as Store;
  answers = [refusal(400, "resource_missing", "No such object"), OK];
  is("an archived choose-your-price Price is made again", await outcome(() => open(noSale, named)), "opened");
  answers = [refusal(429, "rate_limit", "Too many requests"), OK];
  is("being asked to slow down is not about the Price", await outcome(() => open(noSale, named)), "refused: Too many requests");
  answers = [refusal(400, "resource_missing", "No such price"), refusal(400, "resource_missing", "No such price"), OK];
  is("made again once only", await outcome(() => open(noSale, named)), "refused: No such price");
  answers = [refusal(400, "resource_missing", "No such price"), OK];
  is("a product with a price of ours is not made again", await outcome(() => open(noSale, full)), "refused: No such price");

  const coded = { ...noSale, hasDiscounts: true } as Store;
  answers = [refusal(500, "api_error", "Something went wrong"), OK];
  is("a code from a link and a failure: not retried with the box", await outcome(() => open(coded, full, { code: "LINK10" })), "refused: Something went wrong");
  answers = [refusal(402, "card_error", "This promotion needs a card"), OK];
  is("a code from a link refused with another status: not retried", await outcome(() => open(coded, full, { code: "LINK10" })), "refused: This promotion needs a card");
  answers = [refusal(400, "resource_missing", "No such coupon: 'co_back'"), OK];
  is("a come-back coupon refused is not swapped for the box", await outcome(() => open(noSale, full, { coupon: "co_back" })), "refused: No such coupon: 'co_back'");
  answers = [refusal(500, "api_error", "Something went wrong"), OK];
  is("a store that asks for tax numbers: a failure is not a refused box", await outcome(() => open({ ...noSale, tax: { ...noSale.tax, ids: true } } as Store, full)), "refused: Something went wrong");
  answers = [];

  done();
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
