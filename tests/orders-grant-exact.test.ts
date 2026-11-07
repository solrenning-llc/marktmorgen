/**
 * A purchases link whose grant could not be read is said as such, never as
 * an expired link (CX-123 rule 24; Claude 5's review of #2886, LEVE outside
 * its diff). ordersGrant reads the one GET in its exact envelope: an exact
 * null is a link that ran out ("expired", "none"); no answer, a number, an
 * object or two answers for the one GET are unknown, and every caller says
 * "could not be checked, try again": the review door ("error"), the orders
 * page (its error notice), a download (502). The Discord entry's words for
 * these cases are in claude5/discord-join-unknown
 * (tests/discord-join-unknown.test.ts), which reads the grant exactly too.
 *
 * Only the GET of the link's own key is substituted; everything else runs on
 * the in-memory Redis. No account, payment, provider call or email is used.
 */
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { NextRequest } from "next/server";
import { store as redis } from "./redis-stub";
import { paidPeriod } from "./billing-period-fixture";
import { UnknownReplyError } from "@/lib/redis-reply";
import { findPurchase, openOrders, ordersGrant } from "@/lib/buyer-orders";
import { openDoor } from "@/lib/review-proof";
import { ordersWords } from "@/lib/buyer-words/orders";
import { GET as downloadRoute } from "@/app/api/store/download/route";
import { claimHandle, ensureStatsId, ensureStoreId, setStripeAccount, setSubscription, storeForEmail, type Store } from "@/lib/store";

const OWNER = "grant-owner@example.com";
const HANDLE = "grantexact";
const TOKEN = "c".repeat(64);
const REFERENCE = `cs_test_${"GrantExact".padEnd(24, "0")}`;

globalThis.fetch = (async () => {
  throw new Error("No network allowed in this test");
}) as typeof fetch;
process.env.STRIPE_SECRET_KEY = "sk_test_orders_grant_exact_only";

/** The answer the link's GET gets; `undefined` leaves it to the in-memory Redis. */
let grantReply: unknown = undefined;
let substitute = false;
const original = redis.pipeline.bind(redis);
redis.pipeline = (async (commands: (string | number)[][]) => {
  const [first] = commands;
  if (substitute && commands.length === 1 && first[0] === "GET" && String(first[1]).startsWith("nl:orders:link:")) return grantReply;
  return original(commands);
}) as typeof redis.pipeline;

let shop: Store;
beforeEach(async () => {
  substitute = false;
  if (shop) return;
  await claimHandle(OWNER, HANDLE, "Grant Exact", "");
  await ensureStatsId(OWNER);
  await ensureStoreId(OWNER);
  await setStripeAccount(OWNER, "acct_GrantExact01", true);
  await setSubscription(OWNER, { customerId: "cus_GrantExact01", subscriptionId: "sub_GrantExact01", active: true, tier: "scale", period: paidPeriod() });
  shop = (await storeForEmail(OWNER))!;
});

/** Answers the link's GET could get that are not its exact one reply. */
const UNKNOWN: [string, unknown][] = [
  ["no answer", undefined],
  ["a number", 1],
  ["an object", { 0: null }],
  ["two answers for the one GET", [null, null]],
  ["a number in the slot", [1]],
  ["an object in the slot", [{}]],
];

const answering = (reply: unknown) => {
  substitute = true;
  grantReply = reply;
};

for (const [name, reply] of UNKNOWN) {
  test(`ordersGrant: ${name} is unknown, never "no grant"`, async () => {
    answering(reply);
    await assert.rejects(ordersGrant(shop, TOKEN), UnknownReplyError);
  });

  test(`review door through orders: ${name} is an error, not an expired link`, async () => {
    answering(reply);
    assert.deepEqual(await openDoor(shop, { via: "orders", token: TOKEN, reference: REFERENCE }), { state: "error" });
  });

  test(`orders page opening: ${name} is said as unknown, not as an expired link`, async () => {
    answering(reply);
    const opened = await openOrders(shop, TOKEN);
    assert.equal(opened.admitted, true);
    assert.equal(opened.email, null);
    assert.equal(opened.unknown, true);
  });

  test(`download: ${name} is a check that failed (502), not an expired link (410)`, async () => {
    answering(reply);
    await assert.rejects(findPurchase(shop, TOKEN, REFERENCE), UnknownReplyError);
    const response = await downloadRoute(new NextRequest(`https://marktmorgen.test/api/store/download?handle=${HANDLE}&token=${TOKEN}&ref=${REFERENCE}`));
    assert.equal(response.status, 502);
    assert.equal(await response.text(), ordersWords("en").downloadProblems.purchaseCheckFailed);
  });

  // Rule 23 (Claude 5, claude5/orders-grant-exact2): the assertion that the Discord entry says this as "unchecked"
  // (a new notice) was removed with that notice. The case moved to claude5/discord-join-unknown, whose route says it
  // with the existing `failed` notice (tests/discord-join-unknown.test.ts, "orders link, <name>: said as failed").
}

test("an exact null is still an expired link everywhere", async () => {
  answering([null]);
  assert.equal(await ordersGrant(shop, TOKEN), null);
  assert.deepEqual(await openDoor(shop, { via: "orders", token: TOKEN, reference: REFERENCE }), { state: "expired" });
  const opened = await openOrders(shop, TOKEN);
  assert.deepEqual([opened.admitted, opened.email], [true, null]);
  assert.ok(!opened.unknown, "an exact null is a link that ran out, not an unknown one");
  assert.equal(await findPurchase(shop, TOKEN, REFERENCE), null);
  const response = await downloadRoute(new NextRequest(`https://marktmorgen.test/api/store/download?handle=${HANDLE}&token=${TOKEN}&ref=${REFERENCE}`));
  assert.equal(response.status, 410);
  // Rule 23 (Claude 5, claude5/orders-grant-exact2): the assertion that the Discord entry says an exact null as
  // "none" was removed. The case moved to claude5/discord-join-unknown, where a link that ran out goes to the orders
  // page's own expired-link notice (tests/discord-join-unknown.test.ts, "orders link that ran out").
});

// Rule 23 (Claude 5, claude5/orders-grant-exact2): the test that the thanks-page door says an order Stripe could not
// be asked about as "unchecked" was removed with that notice. The case moved to claude5/discord-join-unknown, which
// says it with the existing `failed` notice (tests/discord-join-unknown.test.ts, "thanks page, Stripe could not be
// asked").

test("the orders page says an unknown grant with its error notice, ahead of the expired one", async () => {
  const { readFileSync } = await import("node:fs");
  const page = readFileSync("app/[handle]/orders/page.tsx", "utf8");
  assert.match(page, /token && opened\?\.unknown \? NOTICES\.error : token && !email \? NOTICES\.expired/);
});

test.after(() => {
  redis.pipeline = original;
});
