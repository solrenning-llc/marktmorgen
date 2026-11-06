/**
 * A plan refund may move money only while its durable recovery note is read,
 * written and removed with exact Redis evidence.  These hostile replies model
 * a command whose answer was cut short or lost after the command ran.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { ENDING_KEY, finishPlanRefunds, refundAndEndPlan } from "@/lib/plan-refund-flow";
import { redisPipeline } from "@/lib/redis";
import { store as redis } from "./redis-stub";
import { DAY, NOW, paidShop, world } from "./plan-refund-stripe-world";

type Command = (string | number)[];

const original = redis.pipeline.bind(redis);
const isNote = (commands: Command[], name: string) => commands.length === 1 && commands[0][0] === name && commands[0][1] === ENDING_KEY;

async function reset(): Promise<void> {
  process.env.STRIPE_SECRET_KEY = "sk_test_a_stand_in_key_for_tests_only";
  redis.pipeline = original;
  redis.clear();
  world.calls = [];
  world.refundsDown = false;
  world.loseAnswer = false;
  world.listDown = false;
  world.chargeListDown = false;
  world.endDown = false;
  world.stopDown = false;
  world.refundsLeft = null;
  world.refundStatus = "succeeded";
}

async function rejectsWithoutRefund(run: () => Promise<unknown>, refunds: () => unknown[]): Promise<void> {
  await assert.rejects(run);
  assert.equal(refunds().length, 0, "unknown note evidence must stop before the refund POST");
}

test("plan refund note replies stay exact", async (t) => {
await t.test("a missing HGET pipeline reply is not an absent recovery note", async () => {
  await reset();
  const shop = await paidShop();
  const store = await shop.store();
  redis.pipeline = async (commands) => isNote(commands, "HGET") ? [] : original(commands);
  assert.deepEqual(await redisPipeline([["HGET", ENDING_KEY, store.sid]]), [], "the hostile reply reaches the production reader");
  await rejectsWithoutRefund(() => refundAndEndPlan(store, NOW), shop.refunds);
});

await t.test("a Proxy HGET envelope cannot impersonate one absent note", async () => {
  await reset();
  const shop = await paidShop();
  const store = await shop.store();
  redis.pipeline = async (commands) => isNote(commands, "HGET") ? new Proxy([null], {}) : original(commands);
  await rejectsWithoutRefund(() => refundAndEndPlan(store, NOW), shop.refunds);
});

await t.test("an unreadable stored note is preserved and stops another refund", async () => {
  await reset();
  const shop = await paidShop();
  const store = await shop.store();
  await redisPipeline([["HSET", ENDING_KEY, store.sid, "{"]]);
  await rejectsWithoutRefund(() => refundAndEndPlan(store, NOW), shop.refunds);
  assert.equal((await redisPipeline([["HGET", ENDING_KEY, store.sid]]))[0], "{", "an unreadable prior note is never overwritten");
});

await t.test("a lost initial HSET answer stops before the refund", async () => {
  await reset();
  const shop = await paidShop();
  const store = await shop.store();
  let lost = false;
  redis.pipeline = async (commands) => {
    if (!lost && isNote(commands, "HSET")) {
      lost = true;
      await original(commands);
      return [];
    }
    return original(commands);
  };
  await rejectsWithoutRefund(() => refundAndEndPlan(store, NOW), shop.refunds);
  assert.equal(typeof (await original([["HGET", ENDING_KEY, store.sid]]))[0], "string", "a note whose ACK was lost remains recoverable");
});

await t.test("an accessor HSET reply is rejected without invoking it", async () => {
  await reset();
  const shop = await paidShop();
  const store = await shop.store();
  let reads = 0;
  const accessor: unknown[] = [];
  Object.defineProperty(accessor, "0", { enumerable: true, get() { reads += 1; return 1; } });
  Object.defineProperty(accessor, "length", { value: 1 });
  redis.pipeline = async (commands) => isNote(commands, "HSET") ? accessor : original(commands);
  await rejectsWithoutRefund(() => refundAndEndPlan(store, NOW), shop.refunds);
  assert.equal(reads, 0, "reply getters are never evidence and never execute");
});

await t.test("the exact charge note is acknowledged before money moves", async () => {
  await reset();
  const shop = await paidShop();
  const store = await shop.store();
  let noteWrites = 0;
  redis.pipeline = async (commands) => {
    if (isNote(commands, "HSET")) {
      noteWrites += 1;
      const answer = await original(commands);
      if (noteWrites === 2) return [];
      return answer;
    }
    return original(commands);
  };
  await rejectsWithoutRefund(() => refundAndEndPlan(store, NOW), shop.refunds);
  assert.equal(noteWrites, 2, "the second write binds the exact charges before money moves");
});

await t.test("an unconfirmed HDEL cannot claim the finished recovery note is gone", async () => {
  await reset();
  const shop = await paidShop();
  const store = await shop.store();
  redis.pipeline = async (commands) => isNote(commands, "HDEL") ? [] : original(commands);
  await assert.rejects(() => refundAndEndPlan(store, NOW));
  assert.equal(shop.refunds().length, 1, "the refund itself stays idempotently recorded");
  assert.equal(typeof (await original([["HGET", ENDING_KEY, store.sid]]))[0], "string", "an unconfirmed deletion keeps the recovery note");
});

await t.test("an unknown HGETALL is not an empty recovery job", async () => {
  await reset();
  const shop = await paidShop();
  const store = await shop.store();
  await redisPipeline([["HSET", ENDING_KEY, store.sid, JSON.stringify({ s: store.subscriptionId, at: NOW, t: NOW, m: 0 })]]);
  redis.pipeline = async (commands) => isNote(commands, "HGETALL") ? [] : original(commands);
  await assert.rejects(() => finishPlanRefunds(Date.now() + 10_000, NOW + 60));
  assert.equal(typeof (await original([["HGET", ENDING_KEY, store.sid]]))[0], "string", "an unknown note list is not reported as an empty job");
});

await t.test("a Proxy HGETALL row list is not an empty recovery job", async () => {
  await reset();
  const shop = await paidShop();
  const store = await shop.store();
  await redisPipeline([["HSET", ENDING_KEY, store.sid, JSON.stringify({ s: store.subscriptionId, at: NOW, t: NOW, m: 0 })]]);
  redis.pipeline = async (commands) => isNote(commands, "HGETALL") ? [new Proxy([], {})] : original(commands);
  await assert.rejects(() => finishPlanRefunds(Date.now() + 10_000, NOW + 60));
  assert.equal(typeof (await original([["HGET", ENDING_KEY, store.sid]]))[0], "string");
});

for (const malformed of ["null entry", "valid entry followed by null"] as const) {
await t.test(`present debt evidence with a ${malformed} is retained`, async () => {
  await reset();
  const shop = await paidShop({ at: NOW - 20 * DAY });
  shop.addPayment(NOW - 2 * DAY);
  world.refundsLeft = 1;
  try { await refundAndEndPlan(await shop.store(), NOW); }
  finally { world.refundsLeft = null; }
  const store = await shop.store();
  const note = JSON.parse(String(await shop.note())) as { p: unknown[] };
  assert.equal(note.p.length, 2, "the durable note starts with both debts");
  note.p = malformed === "null entry" ? [null] : [note.p[0], null];
  const damaged = JSON.stringify(note);
  await redisPipeline([["HSET", ENDING_KEY, store.sid, damaged]]);
  const callsBefore = world.calls.length;

  await finishPlanRefunds(Date.now() + 10_000, NOW + 3_601);

  assert.equal(shop.sub().status, "active", "ambiguous debt evidence cannot settle the plan");
  assert.equal(await shop.note(), damaged, "the unknown evidence remains byte-identical for recovery");
  assert.equal(world.calls.slice(callsBefore).filter((call) => call.startsWith("DELETE /subscriptions/")).length, 0);
  assert.equal(shop.refunds().length, 1, "the known partial refund remains the only refund");
});
}
});
