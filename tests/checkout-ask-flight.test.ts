/**
 * #5285 row #4290 (Codex X6's LOW on #4290 @890b0f71e9, NOT FIXED): sendAsked took an ask off the queue and only then,
 * in a separate command, took its entry out of the person's index. A finish whose reply was lost left the buyer's
 * address in the index for good: the key is kept with no expiry, and no run walks it again. Now the take records the
 * ask as in flight (ASK_TAKE), the finish clears both in one step (ASK_DONE), a later run finishes again what was left
 * (sweepAsked), and a person's erasure takes their in-flight records too (ASK_FORGET). Synthetic only: no service is
 * contacted and no email is sent.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { ASK_FLIGHT_SECONDS, askIndexKey, askReminder, forgetAskPerson, sendAsked } from "@/lib/checkout-ask";
import { readListing } from "@/lib/catalog";
import { addProduct, claimHandle, ensureListId, ensureStatsId, ensureStoreId, setProductLink, setRecovery, setStripeAccount, setSubscription, storeForEmail } from "@/lib/store";
import { store as redis } from "./redis-stub";
import { paidPeriod } from "./billing-period-fixture";

const QUEUE = "nl:recover:asks";
const DONE = "nl:recover:asks:done";
const PERSON = "ask-flight@example.test";
const OWNER = "ask-flight-owner@example.test";

async function queued() {
  redis.clear();
  // Existing allowlisted synthetic provider credentials; never a live account. No email is sent by these tests.
  process.env.RESEND_API_KEY ??= "re_test_updates_only_a_stand_in";
  process.env.STRIPE_SECRET_KEY ??= "sk_test_ask_flight_stand_in";
  globalThis.fetch = async () => new Response(JSON.stringify({ object: "list", data: [], has_more: false }), { status: 200 });
  await claimHandle(OWNER, "askflightshop", "Ask Flight Shop", "");
  await ensureStoreId(OWNER);
  await ensureStatsId(OWNER);
  await ensureListId(OWNER);
  await setStripeAccount(OWNER, "acct_1TestFlight01", true);
  await setSubscription(OWNER, { customerId: "cus_AskFlight01", subscriptionId: "sub_AskFlight01", active: true, tier: "pro", period: paidPeriod() });
  await setRecovery(OWNER, { enabled: true, address: "9 Kiln Road, Portland, OR 97201", asks: true });
  const made = await addProduct(OWNER, "Glaze Chart", "", "12", null);
  assert.ok(made.ok);
  await setProductLink(OWNER, made.product.id, `https://example.com/${made.product.id}`);
  const store = (await storeForEmail(OWNER))!;
  const product = (await readListing(store, made.product.id))!;
  assert.equal(await askReminder({ store, product, email: PERSON, ip: "203.0.113.141", from: "page", when: "days" }), "asked");
  const index = askIndexKey(store.statsId!, PERSON);
  const members = redis.run(["ZRANGEBYSCORE", QUEUE, "-inf", "+inf"]) as string[];
  assert.equal(members.length, 1, "the real public writer queued the ask");
  // Due now, so the next run takes it.
  redis.run(["ZADD", QUEUE, 0, members[0]]);
  return { store, index };
}

/** Runs `body` with every write that takes an entry out of the person's index failing, as a reply lost on the way. */
async function withLostFinish<T>(index: string, body: () => Promise<T>): Promise<T> {
  const plain = redis.pipeline;
  const error = console.error;
  console.error = () => {};
  redis.pipeline = (async (batch: (string | number)[][]) => {
    for (const command of batch) {
      const finishes = (command[0] === "ZREM" && command[1] === index) || (command[0] === "EVAL" && String(command[1]).startsWith("-- marktmorgen:ask-done:"));
      if (finishes) throw new Error("synthetic: the finish's reply was lost");
    }
    return plain(batch);
  }) as typeof redis.pipeline;
  try {
    return await body();
  } finally {
    redis.pipeline = plain;
    console.error = error;
  }
}

const holds = (key: string) => (redis.run(["ZRANGEBYSCORE", key, "-inf", "+inf"]) as string[]).some((member) => member.includes(PERSON));

test("a finish whose reply was lost is done again by a later run, so the index keeps no address", async () => {
  const { index } = await queued();
  await withLostFinish(index, () => sendAsked(async () => null, Date.now() + 10_000).catch(() => null));
  assert.equal(holds(QUEUE), false, "the ask left the queue");
  assert.equal(holds(index), true, "(setup) the lost finish left the address in the person's index");
  // An hour and a minute later: the record of its take is that old (sendAsked reads the clock it runs on).
  const old = Math.floor(Date.now() / 1000) - ASK_FLIGHT_SECONDS - 60;
  for (const entry of redis.run(["ZRANGEBYSCORE", DONE, "-inf", "+inf"]) as string[]) redis.run(["ZADD", DONE, old, entry]);
  await sendAsked(async () => null, Date.now() + 10_000);
  assert.equal(redis.run(["EXISTS", index]), 0, "a later run finished it: the person's index is gone");
  assert.equal(holds(DONE), false, "and no record of it in flight is left");
});

test("an ask still in flight is not finished early by another run", async () => {
  const { index } = await queued();
  await withLostFinish(index, () => sendAsked(async () => null, Date.now() + 10_000).catch(() => null));
  await sendAsked(async () => null, Date.now() + 10_000);
  assert.equal(holds(index), true, "within ASK_FLIGHT_SECONDS its entry stays, so an erasure meanwhile still finds it");
});

test("a person's erasure takes their in-flight records too", async () => {
  const { store, index } = await queued();
  await withLostFinish(index, () => sendAsked(async () => null, Date.now() + 10_000).catch(() => null));
  assert.equal(holds(DONE), true, "(setup) the ask is recorded as in flight");
  await forgetAskPerson(store.statsId!, PERSON);
  assert.equal(redis.run(["EXISTS", index]), 0);
  assert.equal(holds(DONE), false, "no record of their ask in flight outlives the erasure");
});

test("a retried ask leaves no in-flight record behind", async () => {
  const { index } = await queued();
  const error = console.error;
  console.error = () => {};
  try {
    assert.deepEqual(await sendAsked(async () => { throw new Error("synthetic store read unavailable"); }, Date.now() + 10_000), { sent: 0, skipped: 0, retried: 1 });
  } finally {
    console.error = error;
  }
  assert.equal(holds(QUEUE), true, "put back for a later try");
  assert.equal(holds(index), true);
  assert.equal(holds(DONE), false, "back in the queue, it is no longer in flight");
});

test("control: a healthy finish clears the index and the in-flight record in one step", async () => {
  const { index } = await queued();
  assert.deepEqual(await sendAsked(async () => null, Date.now() + 10_000), { sent: 0, skipped: 1, retried: 0 });
  assert.equal(redis.run(["EXISTS", QUEUE]), 0);
  assert.equal(redis.run(["EXISTS", index]), 0);
  assert.equal(redis.run(["EXISTS", DONE]), 0);
});
