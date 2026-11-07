/**
 * "Join the Discord" says "no purchase with Discord access" only when that
 * was read exactly (CX-123 rule 24; Claude 5's review of #2641). Before, every
 * missing address became "none": a purchases link whose GET did not answer in
 * its exact shape, a link that ran out after 24 hours, and an order Stripe
 * could not be asked about just now. Now:
 *
 * - not read (Redis or Stripe did not answer): the Discord page's "failed"
 *   notice ("Nothing was changed. Try again in a few minutes.");
 * - a purchases link that ran out (an exact null): the orders page's own
 *   "This link has expired" notice, with the form for a new link, because
 *   the Discord page's "expired" notice speaks of its ten-minute way back;
 * - an order past its three-day window: the orders page's form to get what
 *   was bought again, which holds the Discord button;
 * - an order read exactly that gives nothing here (a session Stripe does not
 *   know): still "none".
 *
 * No new read: the same one GET of the link and the same Stripe read of the
 * order. Only that GET and Stripe's answer are substituted; everything else
 * runs on the in-memory Redis. No account, payment, provider call or email.
 */
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { NextRequest } from "next/server";
import { store as redis } from "./redis-stub";
import { paidPeriod } from "./billing-period-fixture";
import { ordersLinkFor } from "@/lib/buyer-orders";
import { saveServer } from "@/lib/discord-store";
import { storeKey } from "@/lib/learn";
import { POST as joinRoute } from "@/app/api/store/discord/join/route";
import { addProduct, claimHandle, ensureStatsId, ensureStoreId, setStripeAccount, setSubscription, storeForEmail, type Store } from "@/lib/store";

const OWNER = "join-owner@example.com";
const HANDLE = "joinexact";
const TOKEN = "d".repeat(64);
const SESSION = `cs_test_${"JoinExact".padEnd(24, "0")}`;
const DISCORD_PAGE = `https://marktmorgen.test/@${HANDLE}/discord?status=`;

/** What Stripe answers for the checkout session: a function of the path, or a throw (the network refused). */
let stripe: ((path: string) => Response) | null = null;
globalThis.fetch = (async (input: string | URL | Request) => {
  const url = new URL(String(input instanceof Request ? input.url : input));
  if (stripe && url.hostname === "api.stripe.com" && url.pathname.startsWith("/v1/checkout/sessions/")) return stripe(url.pathname);
  throw new Error("No network allowed in this test");
}) as typeof fetch;
process.env.STRIPE_SECRET_KEY = "sk_test_discord_join_unknown_only";
process.env.DISCORD_CLIENT_SECRET = "discord_test_join_unknown_only";
process.env.DISCORD_BOT_TOKEN = "discord_test_join_unknown_only";

/** The answer the link's GET gets while `substitute` is on; a function throws like a refused connection. */
let grantReply: unknown = undefined;
let substitute = false;
const original = redis.pipeline.bind(redis);
redis.pipeline = (async (commands: (string | number)[][]) => {
  const [first] = commands;
  if (substitute && commands.length === 1 && first[0] === "GET" && String(first[1]).startsWith("nl:orders:link:")) {
    if (typeof grantReply === "function") return (grantReply as () => unknown)();
    return grantReply;
  }
  return original(commands);
}) as typeof redis.pipeline;

let shop: Store;
let product = "";
beforeEach(async () => {
  substitute = false;
  stripe = null;
  if (shop) return;
  await claimHandle(OWNER, HANDLE, "Join Exact", "");
  await ensureStatsId(OWNER);
  await ensureStoreId(OWNER);
  await setStripeAccount(OWNER, "acct_JoinExact001", true);
  await setSubscription(OWNER, { customerId: "cus_JoinExact001", subscriptionId: "sub_JoinExact001", active: true, tier: "scale", period: paidPeriod() });
  const made = await addProduct(OWNER, "Join Exact Guide", "", "19");
  assert.ok(made.ok, "the synthetic product is made");
  product = (made as { product: { id: string } }).product.id;
  shop = (await storeForEmail(OWNER))!;
  await saveServer(storeKey(shop), { id: "200000000000000002", name: "Join Discord", at: Math.floor(Date.now() / 1000), kick: false });
});

async function joined(fields: Record<string, string>): Promise<string> {
  const form = new URLSearchParams({ handle: HANDLE, ...fields });
  const response = await joinRoute(
    new NextRequest("https://marktmorgen.test/api/store/discord/join", {
      method: "POST",
      body: form,
      headers: { "content-type": "application/x-www-form-urlencoded", host: "marktmorgen.test", origin: "https://marktmorgen.test", "x-forwarded-for": "203.0.113.10" },
    }),
  );
  assert.equal(response.status, 303);
  return response.headers.get("location") ?? "";
}

/** Answers the link's GET could get that are not its exact one reply. */
const UNKNOWN: [string, unknown][] = [
  ["no answer", undefined],
  ["a number", 1],
  ["an object", { 0: null }],
  ["two answers for the one GET", [null, null]],
  ["a number in the slot", [1]],
  ["an object in the slot", [{}]],
  ["a refused connection", () => {
    throw new Error("connection refused");
  }],
];

for (const [name, reply] of UNKNOWN) {
  test(`orders link, ${name}: said as failed (try again), never as no purchase`, async () => {
    substitute = true;
    grantReply = reply;
    assert.equal(await joined({ token: TOKEN }), `${DISCORD_PAGE}failed`);
  });
}

test("orders link that ran out (an exact null): the orders page's expired-link notice, not no purchase", async () => {
  substitute = true;
  grantReply = [null];
  assert.equal(await joined({ token: TOKEN }), `https://marktmorgen.test/@${HANDLE}/orders?status=expired`);
});

test("control: a live orders link still goes on to Discord's own page", async () => {
  const link = await ordersLinkFor(shop, "buyer@example.com", "https://marktmorgen.test");
  const token = new URL(link!).searchParams.get("token")!;
  const location = await joined({ token });
  assert.match(location, /^https:\/\/discord\.com\//);
});

test("thanks page, Stripe could not be asked (readOrder error): said as failed, never as no purchase", async () => {
  // fetch throws for Stripe: onAccount fails with no status, readOrder says "error".
  assert.equal(await joined({ session_id: SESSION }), `${DISCORD_PAGE}failed`);
});

test("thanks page, Stripe answered 500: said as failed, never as no purchase", async () => {
  stripe = () => new Response(JSON.stringify({ error: { message: "server" } }), { status: 500, headers: { "content-type": "application/json" } });
  assert.equal(await joined({ session_id: SESSION }), `${DISCORD_PAGE}failed`);
});

test("control: a session Stripe does not know (exact 404) is still no purchase", async () => {
  stripe = () => new Response(JSON.stringify({ error: { message: "No such checkout.session" } }), { status: 404, headers: { "content-type": "application/json" } });
  assert.equal(await joined({ session_id: SESSION }), `${DISCORD_PAGE}none`);
});

test("thanks page, an order past its three-day window: the orders page's form, not no purchase", async () => {
  const fourDaysAgo = Math.floor(Date.now() / 1000) - 4 * 24 * 60 * 60;
  stripe = () =>
    new Response(
      JSON.stringify({
        id: SESSION,
        object: "checkout.session",
        status: "complete",
        payment_status: "paid",
        mode: "payment",
        created: fourDaysAgo,
        metadata: { store: HANDLE, product },
        customer_details: { email: "buyer@example.com" },
        payment_intent: null,
      }),
      { status: 200, headers: { "content-type": "application/json" } },
    );
  assert.equal(await joined({ session_id: SESSION }), `https://marktmorgen.test/@${HANDLE}/orders`);
});

test.after(() => {
  redis.pipeline = original;
});
