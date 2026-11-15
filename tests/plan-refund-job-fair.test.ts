/**
 * The daily job's turn for every note (lib/plan-refund-flow.ts, finishPlanRefunds): a note whose refund does not read
 * is kept with its stop (rule 24), so the job must not look at the same MAX_NOTES (50) notes every day. Finding of
 * Claude 5 (review 6732230896, probe tests/c5-3190-probe.test.ts) and Codex G (G102-Q, 5819750050), confirmed by
 * Codex P (6751418567).
 *
 * What fails here: the job takes the first MAX_NOTES fields of the hash on every run. Fifty notes whose refund stays
 * unread hold the front for ever, so a later note whose refund Stripe reads as not made is never decided: its stop is
 * never taken back and the creator's plan ends at the period's end without a refund.
 * After: the job starts each run after the store it looked at last (in store id order, from the start again at the
 * end), so with N notes each one is looked at within ceil(N / MAX_NOTES) runs. Unread notes are never let go to
 * make room. A cursor reply that does not read is unknown: the run decides nothing, never "start from the top".
 * Healthy controls: one note alone is decided on the first run; unread notes keep their stop and their note.
 * Nothing real is reached (tests/plan-refund-stripe-world.ts).
 */
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";
import { ENDING_KEY, MAX_NOTES, SETTLE_SECONDS, finishPlanRefunds } from "@/lib/plan-refund-flow";
import { redisPipeline } from "@/lib/redis";
import { DAY, NOW, paidShop, world } from "./plan-refund-stripe-world";

/** The key the job keeps its place in (lib/plan-refund-flow.ts NEXT_KEY). */
const NEXT = "nl:plan-refund:next";
let k = 0;

async function noted(o: { unread: boolean }) {
  const s = await paidShop({ stopSet: true });
  const sid = (await s.store()).sid;
  const charge = String(world.charges[world.charges.length - 1].id);
  if (o.unread) {
    k += 1;
    // Our refund on the charge, its amount a text: unknown, so the note and the stop stay.
    world.refunds.push({ id: `re_fair${k}x`, object: "refund", charge, payment_intent: `pi_${charge.slice(3)}`, amount: "6900", currency: "usd", status: "succeeded", created: NOW, metadata: { plan_refund: sid } });
  }
  await redisPipeline([["HSET", ENDING_KEY, sid, JSON.stringify({ s: s.subId, at: NOW, t: NOW, m: 1, p: [{ c: charge, a: 6_900 }] })]]);
  return { ...s, sid };
}
const state = async (s: Awaited<ReturnType<typeof noted>>) => [s.sub().cancel_at_period_end, (await s.note()) !== null];

async function main() {
  redis.clear();
  process.env.STRIPE_SECRET_KEY = "sk_test_a_stand_in_key_for_tests_only";
  process.env.RESEND_API_KEY = "re_a_stand_in_key_for_tests_only";
  const run = (day: number) => finishPlanRefunds(Date.now() + 20_000, NOW + SETTLE_SECONDS + 60 + day * DAY);

  part("Controls: a note alone is decided on the first run; an unread one is kept");
  const alone = await noted({ unread: false });
  const unread = await noted({ unread: true });
  await run(0);
  is("no refund made, read: the stop taken back, the note gone", await state(alone), [false, false]);
  is("refund unread: the stop and the note kept", await state(unread), [true, true]);
  await redisPipeline([["HDEL", ENDING_KEY, unread.sid], ["DEL", NEXT]]);

  part(`${MAX_NOTES} notes that never read do not hold back the ones after them`);
  const stuck = [];
  for (let i = 0; i < MAX_NOTES; i += 1) stuck.push(await noted({ unread: true }));
  const later = [await noted({ unread: false }), await noted({ unread: false }), await noted({ unread: false })];
  const notes = MAX_NOTES + later.length;
  const runs = Math.ceil(notes / MAX_NOTES);
  for (let day = 1; day <= runs; day += 1) await run(day);
  is(`after ${runs} runs (ceil(${notes} / ${MAX_NOTES})), each later note read as not made is decided: its stop taken back, its note gone`, await Promise.all(later.map(state)), later.map(() => [false, false]));
  const kept = await Promise.all(stuck.map(state));
  is(`the ${MAX_NOTES} unread ones are never let go to make room: every stop and note kept`, kept.filter(([stop, note]) => stop === true && note === true).length, MAX_NOTES);

  part("A run with no time left looks at nothing and keeps its place");
  const waiting = await noted({ unread: false });
  await finishPlanRefunds(Date.now() - 1, NOW + SETTLE_SECONDS + 60 + 10 * DAY);
  is("no time left: the note and its stop untouched", await state(waiting), [true, true]);
  for (let day = 11; day <= 11 + runs; day += 1) await run(day);
  is(`within the next ${runs + 1} runs it is decided`, await state(waiting), [false, false]);

  part("Rule 24: a place that does not read is unknown, never \"start from the top\"");
  for (const [label, reply] of [["a number", 42], ["an object", {}], ["a list", ["x"]]] as const) {
    const shop = await noted({ unread: false });
    const original = redis.pipeline;
    redis.pipeline = async (commands: (string | number)[][]) => {
      const replies = await original.call(redis, commands);
      return commands.map((command, i) => (command[0] === "GET" && command[1] === NEXT ? reply : replies[i]));
    };
    let threw = false;
    try {
      await run(30);
    } catch {
      threw = true;
    } finally {
      redis.pipeline = original;
    }
    is(`the place read as ${label}: the run refuses, nothing decided on a guess`, [threw, ...(await state(shop))], [true, true, true]);
    await redisPipeline([["HDEL", ENDING_KEY, shop.sid]]);
    shop.sub().cancel_at_period_end = false;
  }
  delete process.env.RESEND_API_KEY;
  done();
}

void main();
