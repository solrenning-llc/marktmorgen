/**
 * Rule 24 on lib/product-updates.ts (Claude 4, r24 product-updates units 1 and 2):
 *
 *   1.1 a stop link that cannot be written gives back, exactly, the month's and the company's day's emails it took;
 *   1.2 the stop link's record (the buyer's address, 400 days) is never written without its confirmed erasure note;
 *   2.1 a queue of updates that does not read is unknown, never "no updates";
 *   2.2 a product's latest update that does not read is unknown, never "none in two months";
 *   2.3 the send's lock holds a value of its own run and is let go only while it still holds it.
 *   2.4 one send whose give-back is unknown does not hold up the other sends of the same run.
 *
 * Synthetic Redis (tests/redis-stub.ts) and synthetic Stripe and Resend answers only.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { advanceUpdate, advanceUpdates, latestUpdate, readUpdateJob, startUpdate } from "@/lib/product-updates";
import { addProduct, claimHandle, ensureListId, ensureStatsId, setMailSettings, setProductLink, setStripeAccount, setSubscription, storeForEmail, storeForHandle } from "@/lib/store";
import { readListing } from "@/lib/catalog";
import { usedThisMonth } from "@/lib/mail";
import { windowId } from "@/lib/allowance-window";
import { forgetNoted } from "@/lib/erasure-index";
import { UnknownReplyError } from "@/lib/redis-reply";
import { store as redis } from "./redis-stub";
import { paidPeriod } from "./billing-period-fixture";

type Command = (string | number)[];
const person = "update-exact-person@example.test";
const dayKey = () => `nl:mail:day:${new Date().toISOString().slice(0, 10)}`;
const stopRecords = () => (redis.run(["SCAN", "0", "MATCH", "nl:upd:stop:*", "COUNT", 1000]) as [string, string[]])[1];
const dayCount = () => Number(redis.run(["GET", dayKey()]) ?? 0);

async function setup() {
  redis.clear();
  const owner = "update-exact-owner@example.test";
  const batches: { to: string | string[] }[][] = [];
  const during: (() => void)[] = [];
  let productId = "";
  process.env.STRIPE_SECRET_KEY = "sk_test_updates_only_a_stand_in";
  process.env.RESEND_API_KEY = "re_test_updates_only_a_stand_in";
  const oldFetch = globalThis.fetch;
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input));
    if (url.hostname === "api.resend.com" && url.pathname === "/emails/batch") {
      for (const step of during) step();
      const batch = JSON.parse(String(init?.body));
      batches.push(batch);
      return Response.json({ data: batch.map((_: unknown, i: number) => ({ id: `synthetic_${i}` })) });
    }
    if (url.hostname !== "api.stripe.com") throw new Error("No real provider call allowed");
    const data = url.pathname === "/v1/checkout/sessions" ? [{
      id: "cs_update_exact", object: "checkout.session", status: "complete", payment_status: "paid",
      created: Math.floor(Date.now() / 1000) - 86400, amount_total: 2700, currency: "usd",
      customer_details: { email: person }, metadata: { store: "updateexact", product: productId },
    }] : [];
    return Response.json({ object: "list", data, has_more: false });
  }) as typeof fetch;
  await claimHandle(owner, "updateexact", "Update Exact", "");
  await ensureStatsId(owner); await ensureListId(owner);
  await setStripeAccount(owner, "acct_1TestHarbor0001", true);
  await setSubscription(owner, { customerId: "cus_UpdateExact", subscriptionId: "sub_UpdateExact", active: true, tier: "pro", period: paidPeriod() });
  await setMailSettings(owner, { fromName: "Update Exact", address: "1 Example St, Example City" });
  const made = await addProduct(owner, "Update exact", "", "27", null);
  assert.ok(made.ok);
  productId = made.product.id;
  await setProductLink(owner, productId, "https://example.com/update");
  const shop = (await storeForEmail(owner))!;
  const product = (await readListing(shop, productId))!;
  const started = await startUpdate(shop, product, "An exact update");
  assert.ok(started.ok, JSON.stringify(started));
  const original = redis.pipeline.bind(redis);
  const restore = () => { redis.pipeline = original; globalThis.fetch = oldFetch; };
  return { shop, productId, job: started.job, batches, during, original, restore };
}

type World = Awaited<ReturnType<typeof setup>>;
const isNote = (c: Command) => c[0] === "ZADD" && String(c[1]).startsWith("nl:erase:ix:");
const isStopWrite = (c: Command) => c[0] === "EVAL" && c.some((a) => String(a).startsWith("nl:upd:stop:"));

/** Runs the send once with the given pipeline in place, and answers what it returned or threw. */
async function runWith(r: World, pipeline: (cs: Command[]) => Promise<unknown[]>) {
  redis.pipeline = pipeline as typeof redis.pipeline;
  try {
    return await advanceUpdate(r.job.id, storeForHandle, Date.now() + 20000).then((job) => ({ job }), (error: unknown) => ({ error }));
  } finally {
    redis.pipeline = r.original;
  }
}

// ---- 1.1: what a send took is given back when its stop links cannot be written

const linkFailures: [string, (r: World) => (cs: Command[]) => Promise<unknown[]>][] = [
  ["the stop link's write throws", (r) => async (cs) => { if (cs.some(isStopWrite)) throw new Error("synthetic stop link write failed"); return r.original(cs); }],
  ["the stop link's write answers in no known shape", (r) => async (cs) => cs.some(isStopWrite) ? [{}] : r.original(cs)],
  ["the erasure note's write throws", (r) => async (cs) => { if (cs.some(isNote)) throw new Error("synthetic erasure note failed"); return r.original(cs); }],
];
for (const [name, make] of linkFailures) {
  test(`1.1 ${name}: the month's and the day's emails taken are given back, exactly, on every run`, async () => {
    const r = await setup();
    try {
      const month = await usedThisMonth(r.shop.listId, windowId(r.shop));
      const day = dayCount();
      for (let run = 0; run < 3; run++) {
        await runWith(r, make(r));
        assert.equal(await usedThisMonth(r.shop.listId, windowId(r.shop)), month, `run ${run}: the store's month is whole`);
        assert.equal(dayCount(), day, `run ${run}: the company's day is whole`);
        assert.equal(r.batches.length, 0, "nothing was sent");
        assert.equal((await readUpdateJob(r.job.id))?.done, 0, "nobody is counted as done");
      }
      // Once the links can be written, the buyer is written to once and counted once.
      const recovered = await advanceUpdate(r.job.id, storeForHandle, Date.now() + 20000);
      assert.deepEqual([recovered?.status, recovered?.done, recovered?.sent], ["sent", 1, 1]);
      assert.equal(r.batches.flat().length, 1);
      assert.equal(await usedThisMonth(r.shop.listId, windowId(r.shop)), month + 1);
      assert.equal(dayCount(), day + 1);
    } finally { r.restore(); }
  });
}

test("1.1 a send whose links failed says so in the job and keeps it for the next run", async () => {
  const r = await setup();
  try {
    const out = await runWith(r, linkFailures[0][1](r));
    assert.ok("job" in out, `the run answers the job, it does not throw: ${String((out as { error?: unknown }).error)}`);
    assert.deepEqual([out.job?.status, out.job?.done, out.job?.sent], ["waiting", 0, 0]);
    assert.match(out.job?.note ?? "", /could not/i);
    assert.deepEqual(redis.run(["SMEMBERS", "nl:updq"]), [r.job.id]);
  } finally { r.restore(); }
});

const unknownReleases: [string, unknown[] | "throw"][] = [
  ["throws", "throw"], ["an empty answer", []], ["a short answer", [0]], ["text", ["0", "x"]], ["objects", [{}, {}]], ["fractions", [0.5, 1]],
];
for (const [name, reply] of unknownReleases) {
  test(`1.1 a give-back that answers ${name} is unknown: the run throws, never a quiet "given back"`, async () => {
    const r = await setup();
    try {
      const out = await runWith(r, async (cs) => {
        if (cs.some(isStopWrite)) throw new Error("synthetic stop link write failed");
        if (cs.length === 2 && cs.every((c) => c[0] === "DECRBY")) {
          if (reply === "throw") throw new Error("synthetic give-back failed");
          return reply;
        }
        return r.original(cs);
      });
      assert.ok("error" in out, "an unconfirmed give-back is not a finished run");
      assert.equal(r.batches.length, 0);
    } finally { r.restore(); }
  });
}

// ---- 1.2: no stop link without its confirmed erasure note

const unknownNotes: [string, unknown[] | "throw"][] = [
  ["throws", "throw"], ["an empty answer", []], ["a short answer", [1, 0]], ["an expiry not set", [1, 0, 0]],
  ["text", ["1", "0", "1"]], ["a null", [null, 0, 1]], ["an object", [{}, 0, 1]], ["a negative count", [1, -1, 1]],
  ["a hole", Object.assign(new Array(3), { 0: 1, 2: 1 })],
];
for (const [name, reply] of unknownNotes) {
  test(`1.2 an erasure note that answers ${name}: no stop link record holds the buyer's address`, async () => {
    const r = await setup();
    try {
      await runWith(r, async (cs) => {
        if (cs.some(isNote)) {
          if (reply === "throw") throw new Error("synthetic erasure note failed");
          return reply;
        }
        return r.original(cs);
      });
      assert.deepEqual(stopRecords(), [], "the record is made only after its note is confirmed");
      assert.equal(r.batches.length, 0);
    } finally { r.restore(); }
  });
}

test("1.2 control: a sent update's stop link is found and deleted by the buyer's erasure", async () => {
  const r = await setup();
  try {
    const sent = await advanceUpdate(r.job.id, storeForHandle, Date.now() + 20000);
    assert.deepEqual([sent?.status, sent?.sent], ["sent", 1]);
    const records = stopRecords();
    assert.equal(records.length, 1);
    assert.ok(JSON.parse(String(redis.run(["GET", records[0]]))).e === person);
    assert.ok((await forgetNoted(r.shop.statsId, person)) >= 1);
    assert.deepEqual(stopRecords(), [], "the erasure found the record");
  } finally { r.restore(); }
});

// ---- 2.1: the queue of updates

const unknownQueues: [string, unknown[] | "throw"][] = [
  ["an empty answer", []], ["a null", [null]], ["a number", [0]], ["an object", [{}]], ["a non-text member", [[7]]],
  ["a hole", [new Array(1)]], ["two answers", [[], []]],
];
for (const [name, reply] of unknownQueues) {
  test(`2.1 a queue that answers ${name} is unknown, never "no updates"`, async () => {
    const r = await setup();
    try {
      redis.pipeline = (async (cs: Command[]) => cs.some((c) => c[0] === "SMEMBERS" && c[1] === "nl:updq") ? reply : r.original(cs)) as typeof redis.pipeline;
      await assert.rejects(advanceUpdates(storeForHandle, Date.now() + 20000), UnknownReplyError);
      assert.equal(r.batches.length, 0);
    } finally { r.restore(); }
  });
}

test("2.1 control: an empty queue is no updates, and a waiting one is moved on", async () => {
  const r = await setup();
  try {
    assert.equal(await advanceUpdates(storeForHandle, Date.now() + 20000), 1);
    assert.equal(r.batches.flat().length, 1);
    assert.equal(await advanceUpdates(storeForHandle, Date.now() + 20000), 0);
  } finally { r.restore(); }
});

// ---- 2.2: a product's latest update

const unknownLatest: [string, unknown[]][] = [
  ["an empty answer", []], ["a number", [1]], ["an object", [{}]], ["undefined", [undefined]], ["two answers", [null, null]],
  ["text that is not a send's id", ["not-an-id"]],
];
for (const [name, reply] of unknownLatest) {
  test(`2.2 a latest update that answers ${name} is unknown, never "none"`, async () => {
    const r = await setup();
    try {
      redis.pipeline = (async (cs: Command[]) => cs.some((c) => c[0] === "GET" && String(c[1]).startsWith("nl:upd:latest:")) ? reply : r.original(cs)) as typeof redis.pipeline;
      await assert.rejects(latestUpdate(r.shop, r.productId), UnknownReplyError);
    } finally { r.restore(); }
  });
}

test("2.2 controls: the latest update is read, and a product never updated has none", async () => {
  const r = await setup();
  try {
    assert.equal((await latestUpdate(r.shop, r.productId))?.id, r.job.id);
    assert.equal(await latestUpdate(r.shop, "no-such-product"), null);
  } finally { r.restore(); }
});

// ---- 2.3: the send's lock

test("2.3 a run whose lock ran out and was taken by another run never lets go of the other run's lock", async () => {
  const r = await setup();
  const lock = `nl:upd:job:${r.job.id}:lock`;
  const seen: unknown[] = [];
  r.during.push(() => {
    seen.push(redis.run(["GET", lock]));
    // The first run is held up past its 90 s; the next run takes the lock.
    redis.run(["SET", lock, "next-run-value", "EX", 90]);
  });
  try {
    const sent = await advanceUpdate(r.job.id, storeForHandle, Date.now() + 20000);
    assert.deepEqual([sent?.status, sent?.sent], ["sent", 1]);
    assert.notEqual(seen[0], "1", "the lock holds a value only this run writes");
    assert.equal(typeof seen[0], "string");
    assert.equal(redis.run(["GET", lock]), "next-run-value", "the other run's lock is left alone");
  } finally { r.restore(); }
});

test("2.3 control: a run lets go of its own lock when it is done", async () => {
  const r = await setup();
  try {
    await advanceUpdate(r.job.id, storeForHandle, Date.now() + 20000);
    assert.equal(redis.run(["GET", `nl:upd:job:${r.job.id}:lock`]), null);
  } finally { r.restore(); }
});

// ---- 2.4: one send that throws does not hold up the others in the same run

/** A second send of the same update under its own id, waiting in the queue beside the first. */
function copyJob(r: World): string {
  const id = r.job.id === "f".repeat(24) ? "e".repeat(24) : "f".repeat(24);
  const job = JSON.parse(String(redis.run(["GET", `nl:upd:job:${r.job.id}`])));
  redis.run(["SET", `nl:upd:job:${id}`, JSON.stringify({ ...job, id })]);
  for (const to of redis.run(["LRANGE", `nl:upd:job:${r.job.id}:to`, 0, -1]) as string[]) redis.run(["RPUSH", `nl:upd:job:${id}:to`, to]);
  redis.run(["SADD", "nl:updq", id]);
  return id;
}

test("2.4 a send whose give-back is unknown still throws, and the other send in the queue is moved on", async () => {
  const r = await setup();
  const copy = copyJob(r);
  const sent = globalThis.fetch;
  let refusedOnce = false;
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    if (!refusedOnce && new URL(String(input)).pathname === "/emails/batch") {
      refusedOnce = true;
      return Response.json({ message: "synthetic refusal" }, { status: 422 });
    }
    return sent(input, init);
  }) as typeof fetch;
  let unknownOnce = false;
  redis.pipeline = (async (cs: Command[]) => {
    if (!unknownOnce && cs.length === 2 && cs.every((c) => c[0] === "DECRBY")) {
      unknownOnce = true;
      return [{}, {}];
    }
    return r.original(cs);
  }) as typeof redis.pipeline;
  try {
    await assert.rejects(advanceUpdates(storeForHandle, Date.now() + 20000), UnknownReplyError, "the step is still logged as failed");
    assert.ok(refusedOnce && unknownOnce, "the first send was refused and its give-back did not read");
    const statuses = [(await readUpdateJob(r.job.id))?.status, (await readUpdateJob(copy))?.status].sort();
    assert.deepEqual(statuses, ["sending", "sent"], "the other send went out in the same run; the unknown one waits");
    assert.equal(r.batches.flat().length, 1);
  } finally { r.restore(); }
});

test("2.4 control: two healthy sends in the queue are both moved on", async () => {
  const r = await setup();
  const copy = copyJob(r);
  try {
    assert.equal(await advanceUpdates(storeForHandle, Date.now() + 20000), 2);
    assert.deepEqual([(await readUpdateJob(r.job.id))?.status, (await readUpdateJob(copy))?.status], ["sent", "sent"]);
  } finally { r.restore(); }
});
