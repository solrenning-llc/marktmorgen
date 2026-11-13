/**
 * #3190's rule kept in #3740 (Claude 1 on #3190, owner rule VR 2): when the daily job concludes no refund was made, a
 * letter may say the plan goes on only once our stop is gone. Our stop is the one set with our mark on the
 * subscription (lib/plan-refund-flow.ts setOurStop, since #3740).
 *
 * What fails here:
 *   - our stop already ended the plan (the subscription is canceled): the letter said the plan goes on as before;
 *   - our stop could not be taken back and the note was past the give-up days: the note was dropped and the letter
 *     said the plan goes on, while our stop would still end it.
 * Control: a live plan with our stop: the stop is taken back, unmarked, and the letter says the plan goes on.
 * Nothing real is reached (tests/plan-refund-stripe-world.ts).
 */
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";
import { ENDING_KEY, SETTLE_SECONDS, finishPlanRefunds } from "@/lib/plan-refund-flow";
import { redisPipeline } from "@/lib/redis";
import { PLAN_REFUND_STOP_MARK } from "@/lib/billing";
import { NOW, paidShop, world } from "./plan-refund-stripe-world";

/** A paid store with our stop on its plan, marked as setOurStop leaves it, and the note of a refund asked at NOW. */
async function stopped() {
  const s = await paidShop();
  const sid = (await s.store()).sid;
  const charge = String(world.charges[world.charges.length - 1].id);
  const sub = world.subs.get(s.subId)!;
  sub.cancel_at_period_end = true;
  sub.metadata = { ...((sub.metadata as Record<string, string> | undefined) ?? {}), [PLAN_REFUND_STOP_MARK]: String(NOW) };
  await redisPipeline([["HSET", ENDING_KEY, sid, JSON.stringify({ s: s.subId, at: NOW, t: NOW, m: 1, p: [{ c: charge, a: 6_900 }] })]]);
  return { ...s, sid };
}
const goesOn = (text: string) => /goes on as before|renews as usual/.test(text);

async function main() {
  redis.clear();
  process.env.STRIPE_SECRET_KEY = "sk_test_a_stand_in_key_for_tests_only";
  process.env.RESEND_API_KEY = "re_a_stand_in_key_for_tests_only";
  const quiet = console.error;
  console.error = () => {};

  part("None was made, and our stop already ended the plan: never told it goes on");
  const gone = await stopped();
  world.subs.get(gone.subId)!.status = "canceled";
  world.emails = [];
  await finishPlanRefunds(Date.now() + 10_000, NOW + SETTLE_SECONDS + 60);
  is("no letter says the plan goes on or renews", world.emails.some((e) => goesOn(e.text)), false);

  part("None was made, our stop could not be taken back, the note past the give-up days: kept, never told it goes on");
  const stuck = await stopped();
  world.stopDown = true;
  world.emails = [];
  await finishPlanRefunds(Date.now() + 10_000, NOW + 8 * 86_400);
  world.stopDown = false;
  is("no letter says the plan goes on or renews while our stop is still set", world.emails.some((e) => goesOn(e.text)), false);
  is("our stop still set, the note kept for tomorrow", [stuck.sub().cancel_at_period_end, (await stuck.note()) !== null], [true, true]);

  part("Control: none was made and the plan is live: our stop is taken back and the plan goes on");
  const live = await stopped();
  world.emails = [];
  await finishPlanRefunds(Date.now() + 10_000, NOW + SETTLE_SECONDS + 60);
  is("the stop taken back and unmarked", [live.sub().cancel_at_period_end, (live.sub().metadata as Record<string, string>)[PLAN_REFUND_STOP_MARK]], [false, undefined]);
  is("the letter says the plan goes on", world.emails.filter((e) => goesOn(e.text)).length, 1);

  console.error = quiet;
  delete process.env.RESEND_API_KEY;
  done();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
