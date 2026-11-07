/**
 * What "Join the Discord" and the pages it sends to say when something on
 * our side could not be read (pre-review of claude5/discord-join-unknown2):
 *
 * - the review door: any failure to read its link (a refused connection, a
 *   timeout, a reply that is not ok) is the page's "error" notice, never a
 *   raw 500 (lib/review-proof.ts, openDoor), for both kinds of link;
 * - the Discord entry: a store, order or link read that failed after Stripe
 *   answered is a notice, never a raw 500; and what it says does not blame
 *   Discord or the server's settings, because Discord was never asked
 *   (VR item 2). A store whose Stripe is not connected goes to the orders
 *   page's own "unavailable" notice, which says that;
 * - an order past its three-day window reaches the orders page with a
 *   sentence that says why;
 * - the orders page never points "below" to a form it does not show, and
 *   when only sending is missing it does not say the store cannot take
 *   payments.
 *
 * Synthetic only: the in-memory Redis, a stubbed Stripe, no network, no
 * account, payment, provider call or email.
 */
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { renderToStaticMarkup } from "react-dom/server";
import { NextRequest } from "next/server";
import { store as redis } from "./redis-stub";
import { paidPeriod } from "./billing-period-fixture";
import { openDoor } from "@/lib/review-proof";
import { DISCORD_WORDS, discordWords } from "@/lib/buyer-words/discord";
import { saveServer } from "@/lib/discord-store";
import { storeKey } from "@/lib/learn";
import OrdersPage from "@/app/[handle]/orders/page";
import { POST as joinRoute } from "@/app/api/store/discord/join/route";
import { addProduct, claimHandle, ensureStatsId, ensureStoreId, setStripeAccount, setSubscription, storeForEmail, type Store } from "@/lib/store";

const OWNER = "join-honest-owner@example.com";
const HANDLE = "joinhonest";
const TOKEN = "e".repeat(64);
const ASK = "f".repeat(48);
const REFERENCE = `cs_test_${"JoinHonest".padEnd(24, "0")}`;
const STRIPE_KEY = "sk_test_join_honest_only";

/** Stripe's answer for a path while set; any other host throws (no network). */
let stripe: ((path: string) => Response) | null = null;
let stripeAnswered = false;
globalThis.fetch = (async (input: string | URL | Request) => {
  const url = new URL(String(input instanceof Request ? input.url : input));
  if (stripe && url.hostname === "api.stripe.com") {
    stripeAnswered = true;
    return stripe(url.pathname);
  }
  throw new Error("No network allowed in this test");
}) as typeof fetch;
process.env.STRIPE_SECRET_KEY = STRIPE_KEY;
process.env.DISCORD_CLIENT_SECRET = "discord_test_join_honest_only";
process.env.DISCORD_BOT_TOKEN = "discord_test_join_honest_only";
delete process.env.RESEND_API_KEY;

/** While `refuseLinks`, a link's GET is refused; while `refuseAfterStripe`, every Redis call after Stripe answered is. */
let refuseLinks = false;
let refuseAfterStripe = false;
const original = redis.pipeline.bind(redis);
redis.pipeline = (async (commands: (string | number)[][]) => {
  const [first] = commands;
  if (refuseAfterStripe && stripeAnswered) throw new Error("connection refused after Stripe");
  if (refuseLinks && commands.length === 1 && first[0] === "GET" && /^nl:(orders|rev):link:/.test(String(first[1]))) throw new Error("connection refused");
  return original(commands);
}) as typeof redis.pipeline;

let shop: Store;
let product = "";
beforeEach(async () => {
  refuseLinks = false;
  refuseAfterStripe = false;
  stripe = null;
  stripeAnswered = false;
  process.env.STRIPE_SECRET_KEY = STRIPE_KEY;
  delete process.env.RESEND_API_KEY;
  if (shop) return;
  await claimHandle(OWNER, HANDLE, "Join Honest", "");
  await ensureStatsId(OWNER);
  await ensureStoreId(OWNER);
  await setStripeAccount(OWNER, "acct_JoinHonest01", true);
  await setSubscription(OWNER, { customerId: "cus_JoinHonest01", subscriptionId: "sub_JoinHonest01", active: true, tier: "scale", period: paidPeriod() });
  const made = await addProduct(OWNER, "Join Honest Guide", "", "19");
  assert.ok(made.ok, "the synthetic product is made");
  product = (made as { product: { id: string } }).product.id;
  shop = (await storeForEmail(OWNER))!;
  await saveServer(storeKey(shop), { id: "200000000000000004", name: "Honest Discord", at: Math.floor(Date.now() / 1000), kick: false });
});

/** The answer to the entry, as "<status> <location>", or the rejection a raw 500 would be. */
async function joined(fields: Record<string, string>, ip = "203.0.113.20"): Promise<string> {
  return joinRoute(
    new NextRequest("https://marktmorgen.test/api/store/discord/join", {
      method: "POST",
      body: new URLSearchParams({ handle: HANDLE, ...fields }),
      headers: { "content-type": "application/x-www-form-urlencoded", host: "marktmorgen.test", origin: "https://marktmorgen.test", "x-forwarded-for": ip },
    }),
  ).then(
    (r) => `${r.status} ${r.headers.get("location") ?? ""}`,
    (e: unknown) => `rejected (raw 500): ${String(e)}`,
  );
}

/** The Discord page's notice the entry sent to, in every language, as one text. */
function discordNoticeSaid(location: string): string[] {
  const status = new URL(location.replace(/^303 /, "")).searchParams.get("status") ?? "";
  return Object.values(DISCORD_WORDS).map((w) => {
    const notice = w.notices[status as keyof typeof w.notices];
    assert.ok(notice, `the Discord page has its own notice for status=${status}`);
    return `${notice.title} ${notice.body}`;
  });
}

const paidSession = (created: number) => () =>
  new Response(
    JSON.stringify({ id: REFERENCE, object: "checkout.session", status: "complete", payment_status: "paid", mode: "payment", created, metadata: { store: HANDLE, product }, customer_details: { email: "buyer@example.com" }, payment_intent: null }),
    { status: 200, headers: { "content-type": "application/json" } },
  );

// ---- The review door -------------------------------------------------------------------------------------------------

test("review door from the orders link: a refused GET of the link is the error notice, not a raw 500", async () => {
  refuseLinks = true;
  const got = await openDoor(shop, { via: "orders", token: TOKEN, reference: REFERENCE }).then((r) => r, (e: unknown) => `rejected: ${String(e)}`);
  assert.deepEqual(got, { state: "error" });
});

test("review door from the review-request link: a refused GET of the link is the error notice, not a raw 500", async () => {
  refuseLinks = true;
  const got = await openDoor(shop, { via: "ask", token: ASK }).then((r) => r, (e: unknown) => `rejected: ${String(e)}`);
  assert.deepEqual(got, { state: "error" });
});

// ---- The Discord entry -----------------------------------------------------------------------------------------------

test("Discord entry, the purchases link could not be read: a notice that does not blame Discord or the server's settings", async () => {
  refuseLinks = true;
  const got = await joined({ token: TOKEN });
  assert.match(got, /^303 https:\/\/marktmorgen\.test\/@joinhonest\/discord\?status=/);
  for (const said of discordNoticeSaid(got)) {
    assert.doesNotMatch(said, /Discord did not let you in|server's settings/, `shown: ${said}`);
  }
  assert.equal(discordWords("en").notices.unchecked.title, "We could not check your purchase just now");
  assert.equal(discordWords("en").notices.unchecked.body, "Nothing was changed. Try again in a few minutes.");
});

test("Discord entry, Stripe could not be asked about the order: the same notice, not the one that blames Discord", async () => {
  // fetch throws for Stripe: readOrder says "error".
  const got = await joined({ session_id: REFERENCE });
  assert.equal(got, `303 https://marktmorgen.test/@${HANDLE}/discord?status=unchecked`);
});

test("Discord entry, Redis refusing the product read after Stripe answered: a notice, never a raw 500", async () => {
  stripe = paidSession(Math.floor(Date.now() / 1000) - 60);
  refuseAfterStripe = true;
  const got = await joined({ session_id: REFERENCE }, "203.0.113.21");
  assert.equal(got, `303 https://marktmorgen.test/@${HANDLE}/discord?status=unchecked`);
});

test("Discord entry, the store's Stripe is not connected: the orders page's own unavailable notice, which says so", async () => {
  delete process.env.STRIPE_SECRET_KEY;
  const got = await joined({ session_id: REFERENCE });
  assert.equal(got, `303 https://marktmorgen.test/@${HANDLE}/orders?status=unavailable`);
});

test("Discord entry, an order past its three-day window: the orders page with a sentence that says why", async () => {
  stripe = paidSession(Math.floor(Date.now() / 1000) - 4 * 24 * 60 * 60);
  const got = await joined({ session_id: REFERENCE });
  assert.equal(got, `303 https://marktmorgen.test/@${HANDLE}/orders?status=discord_window`);
  process.env.RESEND_API_KEY = "re_test_join_honest_only";
  const html = await page({ status: "discord_window" });
  assert.match(html, /The Discord button after checkout works for 3 days/);
  assert.match(html, /action="\/api\/store\/orders"/);
});

// ---- The orders page -------------------------------------------------------------------------------------------------

async function page(query: Record<string, string>): Promise<string> {
  const element = await OrdersPage({ params: Promise.resolve({ handle: `@${HANDLE}` }), searchParams: Promise.resolve(query) } as never);
  return renderToStaticMarkup(element as never);
}

for (const status of ["expired", "busy", "discord_window", "sent"]) {
  test(`orders page, status=${status} while no link can be sent: nothing points "below" to a form that is not there`, async () => {
    const html = await page({ status });
    assert.doesNotMatch(html, /action="\/api\/store\/orders"/, "no form without a sender");
    assert.doesNotMatch(html, /below/i, html);
  });
}

test("orders page, status=expired with a sender: the expired notice still points to the form below it", async () => {
  process.env.RESEND_API_KEY = "re_test_join_honest_only";
  const html = await page({ status: "expired" });
  assert.match(html, /Ask for a new one below/);
  assert.match(html, /action="\/api\/store\/orders"/);
});

test("orders page, Stripe connected but no sender: the intro says links cannot be emailed, not that payments are off", async () => {
  const html = await page({});
  assert.doesNotMatch(html, /cannot take payments through Stripe/);
  assert.match(html, /Join Honest cannot email links to purchases right now/);
});

test("orders page, Stripe not connected: the intro still says the store cannot take payments through Stripe", async () => {
  delete process.env.STRIPE_SECRET_KEY;
  const html = await page({});
  assert.match(html, /Join Honest cannot take payments through Stripe right now/);
});

test.after(() => {
  redis.pipeline = original;
});
