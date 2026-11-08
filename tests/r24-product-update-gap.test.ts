/**
 * Rule 24 on the gap between product-update notices (lib/product-updates.ts):
 * the time a product's buyers were last told, and the SET NX that claims the
 * next notice, are read in their exact shape. An unknown reply never starts a
 * new send (a new job id is a new idempotency key, so the notice would go to
 * every buyer again inside the gap); the healthy path is unchanged.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { advanceUpdate, startUpdate, UPDATE_GAP_SECONDS } from "@/lib/product-updates";
import { addProduct, claimHandle, ensureListId, ensureStatsId, setMailSettings, setProductLink, setStripeAccount, setSubscription, storeForEmail, storeForHandle } from "@/lib/store";
import { readListing } from "@/lib/catalog";
import { store as redis } from "./redis-stub";
import { paidPeriod } from "./billing-period-fixture";

const person = "gap-person@example.test";
const owner = "gap-owner@example.test";

async function setup() {
  redis.clear();
  const batches: unknown[][] = [];
  let stripeReads = 0;
  let productId = "";
  process.env.STRIPE_SECRET_KEY = "sk_test_updates_only_a_stand_in";
  process.env.RESEND_API_KEY = "re_test_updates_only_a_stand_in";
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input));
    if (url.hostname === "api.resend.com" && url.pathname === "/emails/batch") {
      const batch = JSON.parse(String(init?.body));
      batches.push(batch);
      return Response.json({ data: batch.map((_: unknown, i: number) => ({ id: `synthetic_${i}` })) });
    }
    if (url.hostname !== "api.stripe.com") throw new Error("No real provider call allowed");
    if (url.pathname === "/v1/checkout/sessions") stripeReads += 1;
    const data = url.pathname === "/v1/checkout/sessions" ? [{
      id: "cs_gap_evidence", object: "checkout.session", status: "complete", payment_status: "paid",
      created: Math.floor(Date.now() / 1000) - 86400, amount_total: 2700, currency: "usd",
      customer_details: { email: person }, metadata: { store: "gapproof", product: productId },
    }] : [];
    return Response.json({ object: "list", data, has_more: false });
  }) as typeof fetch;
  await claimHandle(owner, "gapproof", "Gap Proof", "");
  await ensureStatsId(owner); await ensureListId(owner);
  await setStripeAccount(owner, "acct_1TestHarbor0001", true);
  await setSubscription(owner, { customerId: "cus_GapProof", subscriptionId: "sub_GapProof", active: true, tier: "pro", period: paidPeriod() });
  await setMailSettings(owner, { fromName: "Gap Proof", address: "1 Example St, Example City" });
  const made = await addProduct(owner, "Gap evidence", "", "27", null);
  assert.ok(made.ok);
  productId = made.product.id;
  await setProductLink(owner, productId, "https://example.com/gap");
  const shop = (await storeForEmail(owner))!;
  const product = (await readListing(shop, productId))!;
  const lastKey = `nl:upd:last:${shop.statsId}:${productId}`;
  return { shop, product, lastKey, batches, stripeReads: () => stripeReads, original: redis.pipeline.bind(redis) };
}

type World = Awaited<ReturnType<typeof setup>>;

/** Nothing was written down to send: no job, nothing queued, nothing sent. */
function nothingQueued(r: World) {
  assert.deepEqual(redis.run(["SMEMBERS", "nl:updq"]), []);
  assert.equal(redis.run(["GET", `nl:upd:latest:${r.shop.statsId}:${r.product.id}`]), null);
  assert.equal(r.batches.length, 0);
}

const isUnknown = (error: unknown) => error instanceof Error && error.name === "UnknownReplyError";

// The last-sent time: anything but a confirmed absent key or a safe non-negative whole number of seconds is unknown.
const unknownLast: [string, (cs: (string | number)[][]) => unknown][] = [
  ["a list", () => [[1]]],
  ["a number", () => [1_700_000_000]],
  ["an object", () => [{}]],
  ["undefined", () => [undefined]],
  ["text that is not a number", () => ["soon"]],
  ["a negative time", () => ["-5"]],
  ["a fraction", () => ["1700000000.5"]],
  ["an empty string", () => [""]],
  ["a short pipeline", () => []],
  ["a long pipeline", () => [null, null]],
];
for (const [label, reply] of unknownLast) {
  test(`R24 gap: an unknown last-sent time (${label}) refuses before anything is read or sent`, async () => {
    const r = await setup();
    redis.pipeline = async (cs) => cs.some((c) => c[0] === "GET" && c[1] === r.lastKey) ? reply(cs) as never : r.original(cs);
    try {
      await assert.rejects(startUpdate(r.shop, r.product, "Unknown gap"), isUnknown);
      assert.equal(r.stripeReads(), 0);
      nothingQueued(r);
    } finally {
      redis.pipeline = r.original;
    }
  });
}

// The claim: "OK" is ours, null is somebody else's; any other reply is unknown and starts nothing.
const unknownClaim: [string, unknown] [] = [
  ["undefined", [undefined]],
  ["an object", [{}]],
  ["a number", [1]],
  ["other text", ["QUEUED"]],
  ["a list", [["OK"]]],
  ["a short pipeline", []],
];
for (const [label, reply] of unknownClaim) {
  test(`R24 gap: an unknown claim reply (${label}) writes no job and sends nothing`, async () => {
    const r = await setup();
    redis.pipeline = async (cs) => cs.some((c) => c[0] === "SET" && c[1] === r.lastKey && c.includes("NX")) ? reply as never : r.original(cs);
    try {
      await assert.rejects(startUpdate(r.shop, r.product, "Unknown claim"), isUnknown);
      nothingQueued(r);
    } finally {
      redis.pipeline = r.original;
    }
  });
}

test("R24 gap control: a confirmed absent last-sent time starts once; a second press inside the gap is soon", async () => {
  const r = await setup();
  const now = Math.floor(Date.now() / 1000);
  const started = await startUpdate(r.shop, r.product, "A real update", now);
  assert.ok(started.ok, JSON.stringify(started));
  assert.equal(redis.run(["GET", r.lastKey]), String(now));
  assert.deepEqual(redis.run(["SMEMBERS", "nl:updq"]), [started.job.id]);
  const again = await startUpdate(r.shop, r.product, "Again", now + 60);
  assert.deepEqual(again, { ok: false, reason: "soon", until: now + UPDATE_GAP_SECONDS });
  const sent = await advanceUpdate(started.job.id, storeForHandle, Date.now() + 20000);
  assert.deepEqual([sent?.status, sent?.done, sent?.sent], ["sent", 1, 1]);
  assert.equal(r.batches.flat().length, 1);
});

test("R24 gap control: a claim lost to another press (null) is soon, with the other press's time", async () => {
  const r = await setup();
  const now = Math.floor(Date.now() / 1000);
  let reads = 0;
  redis.pipeline = async (cs) => {
    // The first read finds nothing; by the claim another press has written its time.
    if (cs.some((c) => c[0] === "GET" && c[1] === r.lastKey) && reads++ === 0) return [null];
    if (cs.some((c) => c[0] === "SET" && c[1] === r.lastKey && c.includes("NX"))) {
      await r.original([["SET", r.lastKey, String(now - 10), "EX", UPDATE_GAP_SECONDS]]);
      return [null];
    }
    return r.original(cs);
  };
  try {
    assert.deepEqual(await startUpdate(r.shop, r.product, "Second press", now), { ok: false, reason: "soon", until: now - 10 + UPDATE_GAP_SECONDS });
    nothingQueued(r);
  } finally {
    redis.pipeline = r.original;
  }
});

// Rule 30, the same claim shape in the same file: the send's own lock is taken only on an exact "OK".
for (const [label, reply] of [["undefined", [undefined]], ["an object", [{}]], ["a number", [1]], ["a short pipeline", []]] as const) {
  test(`R24 gap (rule 30): an unknown lock reply (${label}) moves no send on`, async () => {
    const r = await setup();
    const started = await startUpdate(r.shop, r.product, "Locked");
    assert.ok(started.ok, JSON.stringify(started));
    const lock = `nl:upd:job:${started.job.id}:lock`;
    redis.pipeline = async (cs) => cs.some((c) => c[0] === "SET" && c[1] === lock && c.includes("NX")) ? reply as never : r.original(cs);
    try {
      assert.equal(await advanceUpdate(started.job.id, storeForHandle, Date.now() + 20000), null);
      assert.equal(r.batches.length, 0);
      assert.deepEqual(redis.run(["SMEMBERS", "nl:updq"]), [started.job.id]);
    } finally {
      redis.pipeline = r.original;
    }
    const later = await advanceUpdate(started.job.id, storeForHandle, Date.now() + 20000);
    assert.deepEqual([later?.status, later?.sent], ["sent", 1]);
  });
}
