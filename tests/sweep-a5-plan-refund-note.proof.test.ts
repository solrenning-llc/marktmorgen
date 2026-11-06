/**
 * Sweep A5 proof (CX-123 rule 24), synthetic only. lib/plan-refund-flow.ts finishPlanRefunds, lines 418-424:
 *   const store = note ? await storeForId(sid) : null;
 *   if (!note || !store) { ...; await dropNote(sid); counts.dropped += 1; continue; }
 * storeForId (lib/store.ts:1228-1234) answers null for "no such store" AND for a GET of nl:store:id:<sid> whose
 * reply is lost or in another shape. The daily job then drops the note of a refund that did not go through, and
 * with it the only record that the stop (cancel_at_period_end, set by us before the refund) must be taken back:
 * the creator's paid plan ends at the period's end without a refund and without any email.
 */
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";
import { SETTLE_SECONDS, finishPlanRefunds, refundAndEndPlan } from "@/lib/plan-refund-flow";
import { NOW, paidShop, world } from "./plan-refund-stripe-world";

const original = redis.pipeline.bind(redis);

async function failedRefund() {
  const shop = await paidShop();
  world.refundsDown = true;
  const down = await refundAndEndPlan(await shop.store(), NOW);
  world.refundsDown = false;
  return { shop, down };
}

async function main() {
  redis.clear();
  process.env.STRIPE_SECRET_KEY = "sk_test_a_stand_in_key_for_tests_only";
  process.env.RESEND_API_KEY = "re_a_stand_in_key_for_tests_only";

  part("Healthy control: a refund that failed; the daily job takes our stop back and tells the creator");
  const a = await failedRefund();
  is("the refund failed and our stop is kept for the daily job", [a.down.ok, a.shop.sub().cancel_at_period_end], [false, true]);
  world.emails = [];
  await finishPlanRefunds(Date.now() + 10_000, NOW + SETTLE_SECONDS + 1);
  is("stop taken back, note dropped, plan active", [a.shop.sub().cancel_at_period_end, await a.shop.note(), a.shop.sub().status], [false, null, "active"]);
  is("one email: nothing was refunded", world.emails.length, 1);

  part("DEFECT: the same failed refund, the GET of the store's id answered in an unknown shape");
  for (const [label, reply] of [["a number", 1], ["an object", { ok: true }], ["empty text", ""]] as const) {
    const b = await failedRefund();
    const sid = (await b.shop.store()).sid;
    world.emails = [];
    redis.pipeline = (async (commands: (string | number)[][]) => {
      if (commands.length === 1 && commands[0][0] === "GET" && commands[0][1] === `nl:store:id:${sid}`) return [reply];
      return original(commands);
    }) as typeof redis.pipeline;
    const run = await finishPlanRefunds(Date.now() + 10_000, NOW + SETTLE_SECONDS + 1);
    redis.pipeline = original;
    is(`DEFECT (${label}): the note is dropped as if the store did not exist`, [run.dropped >= 1, await b.shop.note()], [true, null]);
    is(`DEFECT (${label}): our stop is left set, so the paid plan ends at the period's end with no refund`, [b.shop.sub().cancel_at_period_end, b.shop.refunds().length], [true, 0]);
    is(`DEFECT (${label}): the creator is told nothing`, world.emails.length, 0);
    await finishPlanRefunds(Date.now() + 10_000, NOW + SETTLE_SECONDS + 2);
    is(`DEFECT (${label}): the next healthy run cannot repair it (no note left)`, b.shop.sub().cancel_at_period_end, true);
  }
  done();
}
main();
