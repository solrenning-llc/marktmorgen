/**
 * C4-20261106-2610-C6-153, unit B (checkout:252), the proof C4 asked for before any change: a checkout opened from a
 * product page running a test of a second version reads the page only to say which version the visitor was shown
 * (metadata[ab] on the Stripe session, and the test's count). When that read is unknown (Redis fails, answers an
 * extra reply, or holds a page that is not one), the sale is never blocked and no version is claimed: the buyer goes
 * on to Stripe as before, with no metadata[ab], and the test counts nothing for it. Claiming a version from a page
 * that could not be read would be invented. The creator's Stripe account is played by a stand-in for `fetch`.
 */
import { NextRequest } from "next/server";
import { addProduct, claimHandle, ensureStatsId, setProductLink, setProductPage, setStripeAccount, setSubscription, storeForEmail } from "@/lib/store";
import { parsePage, runningTest } from "@/lib/sales-page";
import { writePage } from "@/lib/sales-page-store";
import { AB_COOKIE } from "@/lib/headline-test";
import { POST as checkoutRoute } from "@/app/api/store/checkout/route";
import { withConsent } from "./digital-consent-fixture";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";
import { paidPeriod } from "./billing-period-fixture";
import { afterTasks } from "./next-server-after-world";

process.env.STRIPE_SECRET_KEY = "sk_test_checkout_ab_page_only";

const sessions: URLSearchParams[] = [];
globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const url = new URL(String(input));
  const path = url.pathname.replace(/^\/v1/, "");
  const method = init?.method ?? "GET";
  if (path === "/checkout/sessions" && method === "POST") {
    sessions.push(new URLSearchParams(String(init?.body)));
    return new Response(JSON.stringify({ id: `cs_test_${"a".repeat(24)}`, url: "https://checkout.stripe.com/c/pay/test" }));
  }
  return new Response(JSON.stringify({ error: { message: `no stand-in for ${method} ${path}` } }), { status: 404 });
}) as typeof fetch;

// The page is read with GET on its own key; every other command reaches the stand-in Redis unchanged.
type Answer = "real" | "throws" | "extra" | "garbage";
let answer: Answer = "real";
const sent: (string | number)[][] = [];
const realPipeline = redis.pipeline.bind(redis);
redis.pipeline = (async (commands: (string | number)[][]) => {
  sent.push(...commands);
  const asksPage = commands.some((command) => command[0] === "GET" && String(command[1]).startsWith("nl:product:page:"));
  if (!asksPage || answer === "real") return realPipeline(commands);
  if (answer === "throws") throw new Error("Synthetic Redis failure reading the sales page");
  const replies = await realPipeline(commands);
  if (answer === "extra") return [...replies, "extra"];
  return replies.map((reply, i) => (commands[i][0] === "GET" && String(commands[i][1]).startsWith("nl:product:page:") ? "{not a page" : reply));
}) as typeof redis.pipeline;

const hero = (id: string, headline: string) => ({ id, kind: "hero", headline, sub: "For busy parents", media: "none", video: null });
const text = (id: string, body: string) => ({ id, kind: "text", heading: "", body });
const cta = (id: string) => ({ id, kind: "cta", label: "", note: "" });

async function main(): Promise<void> {
  redis.clear();
  const owner = "abpage@example.com";
  await claimHandle(owner, "abpageshop", "A/B Page Shop", "");
  await ensureStatsId(owner);
  await setStripeAccount(owner, "acct_1TestAbPage0001", true);
  await setSubscription(owner, { customerId: "cus_AbPage000001", subscriptionId: "sub_AbPage000001", active: true, period: paidPeriod() });
  const made = await addProduct(owner, "Forty dinners", "", "29", null);
  if (!made.ok) throw new Error("no product");
  const id = made.product.id;
  await setProductLink(owner, id, "https://example.com/dinners");
  await setProductPage(owner, id, true);
  const store = (await storeForEmail(owner))!;
  const page = parsePage({ blocks: [hero("hero0001", "Forty dinners"), text("text0001", "Each in thirty minutes."), cta("cta00001")], variant: { blocks: [hero("hero0002", "Dinner, sorted"), cta("cta00002"), text("text0002", "Each in thirty minutes.")] } });
  await writePage(store.statsId!, id, page, store);
  const test = runningTest(page);
  is("the page runs a test of a second version", typeof test === "string" && test.length > 0, true);

  const open = async (as: Answer) => {
    answer = as;
    const before = sessions.length;
    const start = sent.length;
    const f = new FormData();
    f.set("handle", "abpageshop");
    f.set("product", id);
    const held = afterTasks.length;
    const response = await checkoutRoute(new NextRequest("https://marktmorgen.com/api/store/checkout", { method: "POST", body: withConsent(f), headers: { host: "marktmorgen.com", cookie: `${AB_COOKIE}=7` } }));
    answer = "real";
    // The stand-in next/server holds what the route left for after its answer; run it, so the test's count is seen.
    for (const task of afterTasks.slice(held)) if (typeof task === "function") await task();
    const session = sessions.length > before ? sessions[sessions.length - 1] : null;
    const counted = sent.slice(start).some((command) => command[0] === "HINCRBY" && String(command[1]).includes(String(test)));
    return { location: response.headers.get("location"), opened: sessions.length - before, ab: session?.get("metadata[ab]") ?? null, counted };
  };

  part("A page read as it is: the version shown is carried to Stripe and counted (as today)");
  const healthy = await open("real");
  is("on to Stripe", [healthy.location, healthy.opened], ["https://checkout.stripe.com/c/pay/test", 1]);
  is("the session says which version this visitor saw", /^[a-z0-9]{4,12}:(a|b)$/.test(healthy.ab ?? ""), true);
  is("and the test counts the checkout for it", healthy.counted, true);

  part("A page that could not be read never blocks the sale, and no version is claimed");
  for (const as of ["throws", "extra", "garbage"] as const) {
    const unknown = await open(as);
    is(`page read ${as}: the buyer still goes on to Stripe`, [unknown.location, unknown.opened], ["https://checkout.stripe.com/c/pay/test", 1]);
    is(`page read ${as}: no version on the session`, unknown.ab, null);
    is(`page read ${as}: the test counts nothing for it`, unknown.counted, false);
  }
  done();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
