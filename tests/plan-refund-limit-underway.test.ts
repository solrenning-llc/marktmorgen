/**
 * A plan refund pressed while an earlier one is still being settled is told it is being handled, never "nothing
 * was refunded", whatever the day's refund counter says (Claude 6's LOW 1 and Claude 1's LOW on #3067): the
 * counter is read first, and its unknown ("unread") and spent ("later") answers both say nothing was refunded and
 * the plan was not changed, which is not true while a refund is underway. Synthetic Stripe and Resend only
 * (tests/plan-refund-stripe-world.ts); the signed-in creator is set by tests/plan-refund-route-world.ts.
 */
import { NextRequest } from "next/server";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";
import { POST } from "@/app/api/billing/refund/route";
import { ENDING_KEY, issueReview } from "@/lib/plan-refund-flow";
import { who } from "./plan-refund-route-world";
import { paidShop } from "./plan-refund-stripe-world";

/** How the day's refund counter (SET NX + INCR of nl:rl:plan-refund:…) answers: as Redis does, lost, or spent. */
let counter: "real" | "lost" | "spent" = "real";
const real = redis.pipeline.bind(redis);
redis.pipeline = (async (commands: (string | number)[][]) => {
  const first = commands[0] ?? [];
  if (counter !== "real" && first[0] === "SET" && String(first[1]).startsWith("nl:rl:plan-refund:")) return counter === "lost" ? [] : ["OK", 999];
  return real(commands);
}) as typeof redis.pipeline;

const post = async (review: string) => {
  const response = await POST(new NextRequest("https://local.example/api/billing/refund", { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: `review=${encodeURIComponent(review)}` }));
  return new URL(response.headers.get("location")!).searchParams.get("done");
};

async function main() {
  redis.clear();
  process.env.STRIPE_SECRET_KEY = "sk_test_a_stand_in_key_for_tests_only";
  process.env.RESEND_API_KEY = "re_a_stand_in_key_for_tests_only";
  const shop = await paidShop();
  who.store = await shop.store();
  who.role = "owner";

  part("No refund underway: the counter's answers as before");
  counter = "lost";
  is("a counter that cannot be read: unread", await post(await issueReview(who.store.sid, 6_900)), "unread");
  counter = "spent";
  is("a spent counter: later", await post(await issueReview(who.store.sid, 6_900)), "later");

  part("A refund underway: told it is being handled, never nothing");
  await real([["HSET", ENDING_KEY, who.store.sid, "1"]]);
  counter = "lost";
  is("a counter that cannot be read: busy", await post(await issueReview(who.store.sid, 6_900)), "busy");
  counter = "spent";
  is("a spent counter: busy", await post(await issueReview(who.store.sid, 6_900)), "busy");
  is("and nothing was refunded by these presses", shop.refunds().length, 0);
  counter = "real";
  done();
}

void main();
