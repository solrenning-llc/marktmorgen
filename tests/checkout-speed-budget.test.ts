/**
 * 277 [H3-2], unit 1: the work on our side between a buyer's click on Buy and the redirect to Stripe's payment page,
 * held to a budget in CI. Counted, never timed, so it does not flake: the database round trips and commands the
 * checkout route makes before it answers, and the requests it sends to Stripe. The figures are what the route does on
 * main today (measured 15 November 2026), so a change that adds a wait before the redirect fails here and has to say
 * why. Stripe's own page is outside this budget and no time is promised for it (docs/checkout-speed.md).
 * Synthetic store; the creator's Stripe account is a stand-in for `fetch`; nothing real is reached.
 */
import { NextRequest } from "next/server";
import { addProduct, claimHandle, ensureStatsId, setProductLink, setStripeAccount, setSubscription } from "@/lib/store";
import { POST as checkoutRoute } from "@/app/api/store/checkout/route";
import { POST as cartRoute } from "@/app/api/store/cart/route";
import { withConsent } from "./digital-consent-fixture";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";

/**
 * The budget, measured on main on 15 November 2026 for one plain product (no options, gift, bundle or extras): what
 * the route does before it answers. The work it hands to after() (counting the visit, the A/B tests) is held by the
 * test world and runs after the buyer is already on their way, so it is not in the budget. Lower is welcome; higher
 * fails, and whoever raises it says why in the same change.
 */
const ROUND_TRIPS_MOST = 7;
const COMMANDS_MOST = 10;
const STRIPE_REQUESTS_MOST = 1;
/** Unit 2: the cart's Buy with two plain products (POST /api/store/cart), measured the same day. */
const CART_ROUND_TRIPS_MOST = 8;
const CART_COMMANDS_MOST = 12;
import { paidPeriod } from "./billing-period-fixture";

process.env.STRIPE_SECRET_KEY = "sk_test_checkout_speed_only";

const stripeCalls: string[] = [];
globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const url = new URL(String(input));
  const path = url.pathname.replace(/^\/v1/, "");
  const method = init?.method ?? "GET";
  stripeCalls.push(`${method} ${path}`);
  if (path === "/checkout/sessions" && method === "POST") return new Response(JSON.stringify({ id: `cs_test_${"s".repeat(24)}`, url: "https://checkout.stripe.com/c/pay/test" }));
  return new Response(JSON.stringify({ error: { message: `no stand-in for ${method} ${path}` } }), { status: 404 });
}) as typeof fetch;

let roundTrips = 0;
let commands = 0;
const realPipeline = redis.pipeline.bind(redis);
redis.pipeline = (async (batch: (string | number)[][]) => {
  roundTrips += 1;
  commands += batch.length;
  return realPipeline(batch);
}) as typeof redis.pipeline;

async function main(): Promise<void> {
  redis.clear();
  const owner = "speed@example.com";
  await claimHandle(owner, "speedshop", "Speed Shop", "");
  await ensureStatsId(owner);
  await setStripeAccount(owner, "acct_1TestSpeed01", true);
  await setSubscription(owner, { customerId: "cus_Speed00001", subscriptionId: "sub_Speed00001", active: true, period: paidPeriod() });
  const made = await addProduct(owner, "Pantry Checklist", "", "9", null);
  if (!made.ok) throw new Error("no product");
  await setProductLink(owner, made.product.id, "https://example.com/pantry");
  const buy = () => {
    const f = new FormData();
    f.set("handle", "speedshop");
    f.set("product", made.product.id);
    return withConsent(f);
  };
  const click = async () => {
    roundTrips = 0;
    commands = 0;
    stripeCalls.length = 0;
    const response = await checkoutRoute(new NextRequest("https://marktmorgen.com/api/store/checkout", { method: "POST", body: buy(), headers: { host: "marktmorgen.com" } }));
    return { location: response.headers.get("location"), roundTrips, commands, stripe: [...stripeCalls] };
  };

  part("One plain product, a buyer's first click: on to Stripe");
  const first = await click();
  is("the buyer is sent on to Stripe's page", first.location, "https://checkout.stripe.com/c/pay/test");
  is(`at most ${ROUND_TRIPS_MOST} database round trips before the redirect`, first.roundTrips <= ROUND_TRIPS_MOST, true);
  is(`at most ${COMMANDS_MOST} database commands before the redirect`, first.commands <= COMMANDS_MOST, true);
  is(`at most ${STRIPE_REQUESTS_MOST} request to Stripe before the redirect: the session itself`, [first.stripe.length <= STRIPE_REQUESTS_MOST, first.stripe[0]], [true, "POST /checkout/sessions"]);

  part("The same click again, as a buyer who went back and pressed Buy once more");
  const again = await click();
  is("sent on to Stripe again", again.location, "https://checkout.stripe.com/c/pay/test");
  is("within the same budget", [again.roundTrips <= ROUND_TRIPS_MOST, again.commands <= COMMANDS_MOST, again.stripe.length <= STRIPE_REQUESTS_MOST], [true, true, true]);
  part("Unit 2: a cart of two plain products, the cart's own Buy");
  const second = await addProduct(owner, "Starter Guide", "", "12", null);
  if (!second.ok) throw new Error("no second product");
  await setProductLink(owner, second.product.id, "https://example.com/starter");
  roundTrips = 0;
  commands = 0;
  stripeCalls.length = 0;
  const cart = new FormData();
  cart.set("handle", "speedshop");
  cart.append("id", made.product.id);
  cart.append("id", second.product.id);
  const cartAnswer = await cartRoute(new NextRequest("https://marktmorgen.com/api/store/cart", { method: "POST", body: withConsent(cart), headers: { host: "marktmorgen.com", origin: "https://marktmorgen.com" } }));
  is("the cart's buyer is sent on to Stripe's page", cartAnswer.headers.get("location"), "https://checkout.stripe.com/c/pay/test");
  is(`at most ${CART_ROUND_TRIPS_MOST} database round trips before the cart's redirect`, roundTrips <= CART_ROUND_TRIPS_MOST, true);
  is(`at most ${CART_COMMANDS_MOST} database commands before the cart's redirect`, commands <= CART_COMMANDS_MOST, true);
  is("one request to Stripe: the session itself", [stripeCalls.length <= STRIPE_REQUESTS_MOST, stripeCalls[0]], [true, "POST /checkout/sessions"]);
  done();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
