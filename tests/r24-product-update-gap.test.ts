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
  ["seconds with a point and nothing after", () => ["1700000000."]],
  ["seconds with ten digits after the point", () => ["1700000000.1234567890"]],
  ["a claim value with a leading zero", () => ["01700000000.123456789"]],
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
      assert.equal(redis.run(["GET", r.lastKey]), null);
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
  // The claim holds a value no other press could write: the time in whole seconds, then a random part.
  assert.match(String(redis.run(["GET", r.lastKey])), new RegExp(`^${now}\\.[0-9]{9}$`));
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

test("R24 gap control: another press's claim in the unique form (seconds, a point, nine digits) is read as its time", async () => {
  const r = await setup();
  const now = Math.floor(Date.now() / 1000);
  redis.run(["SET", r.lastKey, `${now - 10}.123456789`, "EX", UPDATE_GAP_SECONDS]);
  assert.deepEqual(await startUpdate(r.shop, r.product, "Inside the gap", now), { ok: false, reason: "soon", until: now - 10 + UPDATE_GAP_SECONDS });
  nothingQueued(r);
});

/** The claim's SET NX lands, but its reply comes back in no known shape. */
function lostClaimReply(r: World, readBack: "healthy" | "lost") {
  let claimed = false;
  redis.pipeline = async (cs) => {
    if (cs.some((c) => c[0] === "SET" && c[1] === r.lastKey && c.includes("NX"))) {
      await r.original(cs);
      claimed = true;
      return [undefined] as never;
    }
    // The read-back after the claim is lost too: whether the claim is ours is unknown.
    if (readBack === "lost" && claimed && cs.some((c) => c[0] === "GET" && c[1] === r.lastKey)) return [{}] as never;
    return r.original(cs);
  };
}

test("R24 gap: the claim landed and its reply was lost, read back as ours: the update starts once, a second press is soon", async () => {
  const r = await setup();
  const now = Math.floor(Date.now() / 1000);
  lostClaimReply(r, "healthy");
  let started;
  try {
    started = await startUpdate(r.shop, r.product, "Landed", now);
  } finally {
    redis.pipeline = r.original;
  }
  assert.ok(started.ok, JSON.stringify(started));
  assert.deepEqual(redis.run(["SMEMBERS", "nl:updq"]), [started.job.id]);
  assert.deepEqual(await startUpdate(r.shop, r.product, "Again", now + 60), { ok: false, reason: "soon", until: now + UPDATE_GAP_SECONDS });
  const sent = await advanceUpdate(started.job.id, storeForHandle, Date.now() + 20000);
  assert.deepEqual([sent?.status, sent?.sent], ["sent", 1]);
  assert.equal(r.batches.flat().length, 1);
});

test("R24 gap: the claim landed and its reply was lost, and so was the read-back: the claim is let go, so a retry starts the update once", async () => {
  const r = await setup();
  const now = Math.floor(Date.now() / 1000);
  lostClaimReply(r, "lost");
  try {
    await assert.rejects(startUpdate(r.shop, r.product, "Lost", now), isUnknown);
  } finally {
    redis.pipeline = r.original;
  }
  nothingQueued(r);
  // Not held for 7 days with nothing sent: the box never says buyers were told when they were not.
  assert.equal(redis.run(["GET", r.lastKey]), null);
  const retry = await startUpdate(r.shop, r.product, "Retry", now + 5);
  assert.ok(retry.ok, JSON.stringify(retry));
  assert.deepEqual(redis.run(["SMEMBERS", "nl:updq"]), [retry.job.id]);
  const sent = await advanceUpdate(retry.job.id, storeForHandle, Date.now() + 20000);
  assert.deepEqual([sent?.status, sent?.sent], ["sent", 1]);
  assert.equal(r.batches.flat().length, 1);
});

/** The job's own pipeline (the one that queues it): `landed` says whether its writes reach Redis before the reply is lost. */
function lostJobReply(r: World, landed: boolean, whileSending = false) {
  const ids: string[] = [];
  redis.pipeline = async (cs) => {
    const queued = cs.find((c) => c[0] === "SADD" && c[1] === "nl:updq");
    if (!queued) return r.original(cs);
    ids.push(String(queued[2]));
    if (!landed) throw new Error("synthetic network failure");
    await r.original(cs);
    // A send of this job already under way holds its lock.
    if (whileSending) await r.original([["SET", `nl:upd:job:${queued[2]}:lock`, "1", "EX", 90]]);
    return [undefined] as never;
  };
  return ids;
}

for (const landed of [true, false]) {
  test(`R24 gap (job pipeline): the job's writes ${landed ? "landed" : "never landed"} and the reply was lost: the job is taken back and the claim let go, so a retry sends once`, async () => {
    const r = await setup();
    const now = Math.floor(Date.now() / 1000);
    const ids = lostJobReply(r, landed);
    try {
      await assert.rejects(startUpdate(r.shop, r.product, "Job lost", now));
    } finally {
      redis.pipeline = r.original;
    }
    assert.equal(ids.length, 1);
    nothingQueued(r);
    assert.equal(redis.run(["GET", `nl:upd:job:${ids[0]}`]), null);
    assert.equal(redis.run(["EXISTS", `nl:upd:job:${ids[0]}:to`]), 0);
    assert.equal(redis.run(["GET", r.lastKey]), null);
    // The first job, should a run still hold its id, sends nothing.
    await advanceUpdate(ids[0], storeForHandle, Date.now() + 20000);
    assert.equal(r.batches.length, 0);
    const retry = await startUpdate(r.shop, r.product, "Retry", now + 5);
    assert.ok(retry.ok, JSON.stringify(retry));
    const sent = await advanceUpdate(retry.job.id, storeForHandle, Date.now() + 20000);
    assert.deepEqual([sent?.status, sent?.sent], ["sent", 1]);
    assert.equal(r.batches.flat().length, 1);
  });
}

test("R24 gap (job pipeline): the job landed with its reply lost while a send of it is under way: the claim is kept, so nothing goes twice", async () => {
  const r = await setup();
  const now = Math.floor(Date.now() / 1000);
  const ids = lostJobReply(r, true, true);
  try {
    await assert.rejects(startUpdate(r.shop, r.product, "Job sending", now));
  } finally {
    redis.pipeline = r.original;
  }
  assert.deepEqual(redis.run(["SMEMBERS", "nl:updq"]), ids);
  assert.match(String(redis.run(["GET", r.lastKey])), new RegExp(`^${now}\\.[0-9]{9}$`));
  assert.deepEqual(await startUpdate(r.shop, r.product, "Again", now + 60), { ok: false, reason: "soon", until: now + UPDATE_GAP_SECONDS });
  redis.run(["DEL", `nl:upd:job:${ids[0]}:lock`]);
  const sent = await advanceUpdate(ids[0], storeForHandle, Date.now() + 20000);
  assert.deepEqual([sent?.status, sent?.sent], ["sent", 1]);
  assert.equal(r.batches.flat().length, 1);
});
