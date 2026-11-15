/**
 * 277 [H3-2], unit 1: the work on our side between a buyer's click on Buy and the redirect to Stripe's payment page,
 * held to a budget in CI. Counted, never timed, so it does not flake: the database round trips and commands the
 * checkout route makes before it answers, and the requests it sends to Stripe. The figures are what the route does on
 * main today (measured 15 November 2026), so a change that adds a wait before the redirect fails here and has to say
 * why. Stripe's own page is outside this budget and no time is promised for it (docs/checkout-speed.md).
 * Synthetic store; the creator's Stripe account is a stand-in for `fetch`; nothing real is reached.
 */
import { NextRequest } from "next/server";
import { addOption, addProduct, claimHandle, ensureStatsId, setProductBundle, setProductCourse, setProductExtras, setProductLink, setProductShipping, setStripeAccount, setSubscription, storeForEmail } from "@/lib/store";
import { editCourse, emptyCourse, saveCourse } from "@/lib/course";
import { parseShipping } from "@/lib/shipping";
import { readProduct } from "@/lib/catalog";
import { setSoon } from "@/lib/waitlist";
import { setExpectedDay } from "@/lib/preorders";
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
/** Unit 3, measured the same day: a box checked at checkout, a gift and a fixed bundle, each [round trips, commands]. */
const MORE_MOST: Record<"bump" | "gift" | "bundle", [number, number]> = { bump: [7, 10], gift: [8, 11], bundle: [7, 10] };
/** Unit 4, measured the same day: a price option, a bundle the buyer builds and a payment plan, each [round trips, commands]. */
const UNIT4_MOST: Record<"option" | "pick" | "plan", [number, number]> = { option: [7, 10], pick: [7, 10], plan: [8, 11] };
/** Unit 5, measured the same day: a monthly subscription and a pre-order, each [round trips, commands]. */
const UNIT5_MOST: Record<"subscription" | "preorder", [number, number]> = { subscription: [7, 10], preorder: [7, 10] };
/** Unit 6, measured the same day: a course and a physical product, each [round trips, commands]. */
const UNIT6_MOST: Record<"course" | "physical", [number, number]> = { course: [7, 10], physical: [7, 10] };
import { paidPeriod } from "./billing-period-fixture";

process.env.STRIPE_SECRET_KEY = "sk_test_checkout_speed_only";

const stripeCalls: string[] = [];
/** The last session asked of Stripe, to tell which path the click took. */
let lastSession = new URLSearchParams();
globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const url = new URL(String(input));
  const path = url.pathname.replace(/^\/v1/, "");
  const method = init?.method ?? "GET";
  stripeCalls.push(`${method} ${path}`);
  if (path === "/checkout/sessions" && method === "POST") lastSession = new URLSearchParams(String(init?.body));
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
  part("Unit 3: a box checked at checkout, a gift and a bundle");
  const measure = async (label: "bump" | "gift" | "bundle", fill: (f: FormData) => void) => {
    roundTrips = 0;
    commands = 0;
    stripeCalls.length = 0;
    const f = new FormData();
    f.set("handle", "speedshop");
    fill(f);
    const response = await checkoutRoute(new NextRequest("https://marktmorgen.com/api/store/checkout", { method: "POST", body: withConsent(f), headers: { host: "marktmorgen.com" } }));
    const [tripsMost, commandsMost] = MORE_MOST[label];
    is(`${label}: on to Stripe's page`, response.headers.get("location"), "https://checkout.stripe.com/c/pay/test");
    is(`${label}: at most ${tripsMost} round trips and ${commandsMost} commands, one request to Stripe`, [roundTrips <= tripsMost, commands <= commandsMost, stripeCalls.length <= STRIPE_REQUESTS_MOST], [true, true, true]);
  };
  const added = await addProduct(owner, "Recipe Cards", "", "6", null);
  if (!added.ok) throw new Error("no extra product");
  await setProductLink(owner, added.product.id, "https://example.com/cards");
  const extra = await setProductExtras(owner, second.product.id, { bump: { productId: added.product.id, priceCents: 500, pitch: "Add it." }, slot: 0 });
  if (!extra.ok) throw new Error(`no box: ${extra.reason}`);
  await measure("bump", (f) => { f.set("product", second.product.id); f.append("bump", "yes"); });
  await measure("gift", (f) => { f.set("product", second.product.id); f.set("gift_to", "friend@example.com"); f.set("gift_from", "Ana"); });
  const set = await addProduct(owner, "Starter Set", "", "19", null);
  if (!set.ok) throw new Error("no bundle");
  const bundled = await setProductBundle(owner, set.product.id, [made.product.id, second.product.id]);
  if (!bundled.ok) throw new Error(`no bundle: ${bundled.reason}`);
  await measure("bundle", (f) => { f.set("product", set.product.id); });
  part("Unit 4: a price option, a bundle the buyer builds and a payment plan");
  const unit4 = async (label: "option" | "pick" | "plan", fill: (f: FormData) => void) => {
    roundTrips = 0;
    commands = 0;
    stripeCalls.length = 0;
    const f = new FormData();
    f.set("handle", "speedshop");
    fill(f);
    const response = await checkoutRoute(new NextRequest("https://marktmorgen.com/api/store/checkout", { method: "POST", body: withConsent(f), headers: { host: "marktmorgen.com" } }));
    const [tripsMost, commandsMost] = UNIT4_MOST[label];
    is(`${label}: on to Stripe's page`, response.headers.get("location"), "https://checkout.stripe.com/c/pay/test");
    is(`${label}: at most ${tripsMost} round trips and ${commandsMost} commands, one request to Stripe`, [roundTrips <= tripsMost, commands <= commandsMost, stripeCalls.length <= STRIPE_REQUESTS_MOST], [true, true, true]);
  };
  const priced = await addProduct(owner, "Bread Course", "", "29", null);
  if (!priced.ok) throw new Error("no priced product");
  const optioned = await addOption(owner, priced.product.id, "Printed copy", "39");
  if (!optioned.ok) throw new Error(`no option: ${optioned.reason}`);
  const option = (await readProduct(optioned.store, priced.product.id))!.options[0];
  await setProductLink(owner, option.id, "https://example.com/printed");
  await unit4("option", (f) => { f.set("product", priced.product.id); f.set("option", option.id); });
  const pickSet = await addProduct(owner, "Pick Two", "", "15", null);
  if (!pickSet.ok) throw new Error("no pick bundle");
  const picked = await setProductBundle(owner, pickSet.product.id, [made.product.id, second.product.id, added.product.id], 2);
  if (!picked.ok) throw new Error(`no pick bundle: ${picked.reason}`);
  await unit4("pick", (f) => { f.set("product", pickSet.product.id); f.append("pick", made.product.id); f.append("pick", second.product.id); });
  const planned = await setProductExtras(owner, made.product.id, { plan: { payments: 3, interval: "month", amountCents: 300 } });
  if (!planned.ok) throw new Error(`no plan: ${planned.reason}`);
  await unit4("plan", (f) => { f.set("product", made.product.id); f.set("pay", "plan"); });
  part("Unit 5: a monthly subscription and a pre-order, the recurring and the early money");
  const unit5 = async (label: "subscription" | "preorder", fill: (f: FormData) => void) => {
    roundTrips = 0;
    commands = 0;
    stripeCalls.length = 0;
    const f = new FormData();
    f.set("handle", "speedshop");
    fill(f);
    const response = await checkoutRoute(new NextRequest("https://marktmorgen.com/api/store/checkout", { method: "POST", body: withConsent(f), headers: { host: "marktmorgen.com" } }));
    const [tripsMost, commandsMost] = UNIT5_MOST[label];
    is(`${label}: on to Stripe's page`, response.headers.get("location"), "https://checkout.stripe.com/c/pay/test");
    // The path it took, so the budget is the subscription's or the pre-order's own, not a plain sale's.
    is(`${label}: its own kind of session`, label === "subscription" ? lastSession.get("mode") : lastSession.get("metadata[preorder]"), label === "subscription" ? "subscription" : "yes");
    is(`${label}: at most ${tripsMost} round trips and ${commandsMost} commands, one request to Stripe`, [roundTrips <= tripsMost, commands <= commandsMost, stripeCalls.length <= STRIPE_REQUESTS_MOST], [true, true, true]);
  };
  const monthly = await addProduct(owner, "Bakers Club", "", "9", { interval: "month", trialDays: 0, payments: 0 });
  if (!monthly.ok) throw new Error("no subscription product");
  await setProductLink(owner, monthly.product.id, "https://example.com/club");
  await unit5("subscription", (f) => { f.set("product", monthly.product.id); });
  const early = await addProduct(owner, "Sourdough Book", "", "25", null);
  if (!early.ok) throw new Error("no pre-order product");
  await setProductLink(owner, early.product.id, "https://example.com/book");
  const shop = (await storeForEmail(owner))!;
  await setSoon(shop, early.product.id, true);
  await setExpectedDay(shop, early.product.id, new Date(Date.now() + 30 * 86_400_000).toISOString().slice(0, 10));
  await unit5("preorder", (f) => { f.set("product", early.product.id); f.set("preorder", "yes"); });
  part("Unit 6: a course and a physical product");
  const unit6 = async (label: "course" | "physical", fill: (f: FormData) => void) => {
    roundTrips = 0;
    commands = 0;
    stripeCalls.length = 0;
    const f = new FormData();
    f.set("handle", "speedshop");
    fill(f);
    const response = await checkoutRoute(new NextRequest("https://marktmorgen.com/api/store/checkout", { method: "POST", body: withConsent(f), headers: { host: "marktmorgen.com" } }));
    const [tripsMost, commandsMost] = UNIT6_MOST[label];
    is(`${label}: on to Stripe's page`, response.headers.get("location"), "https://checkout.stripe.com/c/pay/test");
    // A physical product's session asks for the delivery address; a course's never does.
    is(`${label}: its own kind of session`, lastSession.has("metadata[ship]"), label === "physical");
    is(`${label}: at most ${tripsMost} round trips and ${commandsMost} commands, one request to Stripe`, [roundTrips <= tripsMost, commands <= commandsMost, stripeCalls.length <= STRIPE_REQUESTS_MOST], [true, true, true]);
  };
  const lessons = await addProduct(owner, "Baking Course", "", "49", null);
  if (!lessons.ok) throw new Error("no course product");
  let outline = emptyCourse();
  const added1 = editCourse(outline, { op: "lesson-add", moduleId: outline.modules[0].id, title: "Opening" });
  if (!added1.ok) throw new Error("no lesson");
  outline = added1.course;
  if (!(await setProductCourse(owner, lessons.product.id, { id: outline.id, lessons: 1 })).ok) throw new Error("no course");
  await saveCourse(outline, (await storeForEmail(owner))!);
  await unit6("course", (f) => { f.set("product", lessons.product.id); });
  const book = await addProduct(owner, "Printed Book", "", "30", null);
  if (!book.ok) throw new Error("no physical product");
  const shipped = await setProductShipping(owner, book.product.id, parseShipping({ cents: 600, region: "na", note: "" })!);
  if (!shipped.ok) throw new Error(`no shipping: ${shipped.reason}`);
  await unit6("physical", (f) => { f.set("product", book.product.id); });
  done();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
