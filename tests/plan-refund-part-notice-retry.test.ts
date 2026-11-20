import { test } from "node:test";
import assert from "node:assert/strict";
import { finishPlanRefunds, refundAndEndPlan, GIVE_UP_DAYS, ENDING_KEY } from "@/lib/plan-refund-flow";
import { store as redis } from "./redis-stub";
import { DAY, NOW, paidShop, world } from "./plan-refund-stripe-world";

test("a partial refund's recovery note survives a refused notice, and the next run tells once", async () => {
 redis.clear();
 process.env.STRIPE_SECRET_KEY = "sk_test_stand_in_only";
 delete process.env.RESEND_API_KEY;
 const shop = await paidShop({ at: NOW - 20 * DAY });
 shop.addPayment(NOW - 2 * DAY);
 world.refundsLeft = 1;
 try { await refundAndEndPlan(await shop.store(), NOW); } finally { world.refundsLeft = null; }
 const note = await shop.note();
 assert.equal(typeof note, "string");
 assert.equal(shop.allRefunds().length, 1);
 const at = NOW + (GIVE_UP_DAYS + 1) * DAY;
 world.emails = [];
 const refused = await finishPlanRefunds(Date.now() + 10_000, at);
 assert.deepEqual([refused.left, refused.dropped, await shop.note()], [1, 0, note], "the only retry evidence must survive while no sender can tell the creator");
 assert.deepEqual([shop.sub().status, shop.sub().cancel_at_period_end, shop.allRefunds().length, world.emails.length], ["active", true, 1, 0]);
 process.env.RESEND_API_KEY = "re_a_stand_in_key_for_tests_only";
 const recovered = await finishPlanRefunds(Date.now() + 10_000, at + 60);
 assert.deepEqual([recovered.dropped, await shop.note(), world.emails.length], [1, null, 1]);
 await finishPlanRefunds(Date.now() + 10_000, at + 120);
 assert.equal(world.emails.length, 1);
 assert.equal(shop.allRefunds().length, 1, "a notice retry must not make the second refund");
});


test("a confirmed partial-refund notice is not sent twice when deleting its note is unconfirmed", async () => {
 redis.clear();
 process.env.STRIPE_SECRET_KEY = "sk_test_stand_in_only";
 delete process.env.RESEND_API_KEY;
 const shop = await paidShop({ at: NOW - 20 * DAY });
 shop.addPayment(NOW - 2 * DAY);
 world.refundsLeft = 1;
 try { await refundAndEndPlan(await shop.store(), NOW); } finally { world.refundsLeft = null; }
 const note = await shop.note();
 assert.equal(typeof note, "string");
 world.emails = [];
 process.env.RESEND_API_KEY = "re_a_stand_in_key_for_tests_only";
 const at = NOW + (GIVE_UP_DAYS + 1) * DAY;
 const sid = (await shop.store()).sid;
 const pipeline = redis.pipeline.bind(redis);
 let refused = false;
 redis.pipeline = async commands => {
   if (!refused && commands.some(c => c[0] === "HDEL" && c[1] === ENDING_KEY && c[2] === sid)) {
     refused = true;
     return commands.map(() => null);
   }
   return pipeline(commands);
 };
 try {
   const first = await finishPlanRefunds(Date.now() + 10_000, at);
   assert.deepEqual([refused, first.left, await shop.note(), world.emails.length], [true, 1, note, 1]);
 } finally { redis.pipeline = pipeline; }
 const recovered = await finishPlanRefunds(Date.now() + 10_000, at + 60);
 assert.deepEqual([recovered.dropped, await shop.note(), world.emails.length], [1, null, 1]);
 assert.equal(shop.allRefunds().length, 1);
 delete process.env.RESEND_API_KEY;
});
