/**
 * Sweep app1 proof (CX-123 rules 24 and 30), synthetic only. A product marked "coming soon" takes a waitlist sign-up
 * and never opens a checkout. Whether it is coming soon is read with:
 *   lib/preorders.ts:67   soonState  `Array.isArray(members) ? members : []`        (cart, app/api/store/cart/route.ts:282)
 *   lib/preorders.ts:74   soonOne    `member === 1 || member === "1"`               (checkout, app/api/store/checkout/route.ts:163)
 *   lib/waitlist.ts:75    isSoon     `raw === 1 || raw === "1"`                     (book, app/api/store/book/route.ts:110)
 * and every route adds `.catch(() => "not soon")`. A reply lost or in another shape reads as "not coming soon", so the
 * buyer is sent to a card form for a product the creator has not released: Stripe is reached and a charge can follow.
 * The creator's Stripe account is a stand-in for `fetch`; nothing real is reached.
 */
import { NextRequest } from "next/server";
import { addProduct, claimHandle, ensureStatsId, setProductLink, setStripeAccount, setSubscription, storeForEmail } from "@/lib/store";
import { setSoon } from "@/lib/waitlist";
import { POST as checkoutRoute } from "@/app/api/store/checkout/route";
import { POST as cartRoute } from "@/app/api/store/cart/route";
import { withConsent } from "./digital-consent-fixture";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";
import { paidPeriod } from "./billing-period-fixture";

process.env.STRIPE_SECRET_KEY = "sk_test_sweep_app1_soon";

const sessions: URLSearchParams[] = [];
globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const path = new URL(String(input)).pathname.replace(/^\/v1/, "");
  if (path === "/checkout/sessions" && (init?.method ?? "GET") === "POST") {
    sessions.push(new URLSearchParams(String(init?.body)));
    return new Response(JSON.stringify({ id: `cs_test_${"s".repeat(24)}`, url: "https://checkout.stripe.com/c/pay/soon" }));
  }
  return new Response(JSON.stringify({ error: { message: "no stand-in" } }), { status: 404 });
}) as typeof fetch;

type Answer = "real" | "lost" | "null" | "text" | "throws";
let answer: Answer = "real";
const realPipeline = redis.pipeline.bind(redis);
redis.pipeline = (async (commands: (string | number)[][]) => {
  const asksSoon = commands.some((c) => (c[0] === "SMEMBERS" || c[0] === "SISMEMBER") && String(c[1]).endsWith(":soon"));
  if (!asksSoon || answer === "real") return realPipeline(commands);
  if (answer === "throws") throw new Error("Synthetic Redis failure reading the coming-soon set");
  const replies = await realPipeline(commands);
  if (answer === "lost") return [];
  return replies.map((reply, i) => ((commands[i][0] === "SMEMBERS" || commands[i][0] === "SISMEMBER") && String(commands[i][1]).endsWith(":soon") ? (answer === "null" ? null : "QUEUED") : reply));
}) as typeof redis.pipeline;

async function main(): Promise<void> {
  redis.clear();
  const owner = "soon@example.com";
  await claimHandle(owner, "soonshop", "Soon Shop", "");
  await ensureStatsId(owner);
  await setStripeAccount(owner, "acct_1TestSweepSoon1", true);
  await setSubscription(owner, { customerId: "cus_SweepSoon001", subscriptionId: "sub_SweepSoon001", active: true, period: paidPeriod() });
  const made = await addProduct(owner, "Next course", "", "49", null);
  if (!made.ok) throw new Error("no product");
  await setProductLink(owner, made.product.id, "https://example.com/next");
  const store = (await storeForEmail(owner))!;
  await setSoon(store, made.product.id, true);

  const open = async (as: Answer) => {
    answer = as;
    const before = sessions.length;
    const f = new FormData();
    f.set("handle", "soonshop");
    f.set("product", made.product.id);
    const response = await checkoutRoute(new NextRequest("https://marktmorgen.com/api/store/checkout", { method: "POST", body: withConsent(f), headers: { host: "marktmorgen.com" } }));
    answer = "real";
    return [response.headers.get("location"), sessions.length - before];
  };
  const openCart = async (as: Answer) => {
    answer = as;
    const before = sessions.length;
    const f = new FormData();
    f.set("handle", "soonshop");
    f.set("id", made.product.id);
    const response = await cartRoute(new NextRequest("https://marktmorgen.com/api/store/cart", { method: "POST", body: withConsent(f), headers: { host: "marktmorgen.com", origin: "https://marktmorgen.com" } }));
    answer = "real";
    return [response.headers.get("location"), sessions.length - before];
  };

  part("Healthy control: a coming-soon product opens no checkout");
  is("checkout: sent to the waitlist, Stripe never reached", await open("real"), [`https://marktmorgen.com/@soonshop/p/${made.product.id}#waitlist`, 0]);
  is("cart: back to the cart as changed, Stripe never reached", await openCart("real"), ["https://marktmorgen.com/@soonshop?cart=changed#cart", 0]);

  part("DEFECT: the coming-soon read lost, thrown or in another shape reads as 'released'");
  for (const as of ["lost", "null", "text", "throws"] as const) {
    is(`DEFECT checkout (${as}): a Stripe checkout is opened for the unreleased product`, await open(as), ["https://checkout.stripe.com/c/pay/soon", 1]);
    is(`DEFECT cart (${as}): a Stripe checkout is opened for the unreleased product`, await openCart(as), ["https://checkout.stripe.com/c/pay/soon", 1]);
  }
  is("while the product is still marked coming soon", (await realPipeline([["SISMEMBER", `nl:wl:${store.statsId}:soon`, made.product.id]]))[0], 1);
  done();
}
main();
