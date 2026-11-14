/**
 * #3067 after main's 588 [KB9] unit 3: the plan withdrawal route
 * (app/api/billing/withdraw) calls withinLimit, which now throws
 * UnknownReplyError when its count comes back in a shape that cannot be read
 * (lib/request-guard.ts; CX-123 rule 24). The route must answer that in its
 * own words, the refund page's "error" notice ("try again"), never "later"
 * (too many today) and never a bare 500 with no page; nothing is recorded and
 * no receipt goes. A count past the limit still answers "later".
 *
 * Against the stand-in Stripe and Resend of tests/plan-refund-stripe-world.ts
 * and the in-memory Redis; synthetic data only, nothing real is reached.
 */
import { NextRequest } from "next/server";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";
import { POST } from "@/app/api/billing/withdraw/route";
import { planWithdrawKey } from "@/lib/plan-withdrawal";
import { redisPipeline } from "@/lib/redis";
import { who } from "./plan-refund-route-world";
import { paidShop, world } from "./plan-refund-stripe-world";

const DAY = 86_400;
const REAL = Math.floor(Date.now() / 1000);
const NAME = "Ana Souza";
const ADDRESS = "ana.receipts@example.com";

/** The withdrawal's answer: the `withdraw` state of the redirect, or what else came back. */
const post = async (): Promise<string> => {
  let response: Response;
  try {
    response = await POST(new NextRequest("https://local.example/api/billing/withdraw", { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ name: NAME, email: ADDRESS }).toString() }));
  } catch (error) {
    return `threw ${error instanceof Error ? error.name : String(error)}`;
  }
  const location = response.headers.get("location");
  return location ? new URL(location).searchParams.get("withdraw") ?? `no state ${location}` : `status ${response.status}`;
};
const receipts = () => world.emails.filter((e) => e.to === ADDRESS && e.subject.includes("withdrawal"));

/** The plan-withdraw counter's reply replaced by `reply`; null leaves every reply as the stand-in gives it. */
let reply: unknown = null;
const pipeline = redis.pipeline.bind(redis);
redis.pipeline = (async (commands: (string | number)[][]) => {
  if (reply !== null && commands[0]?.[0] === "SET" && String(commands[0]?.[1] ?? "").startsWith("nl:rl:plan-withdraw:")) return reply;
  return pipeline(commands);
}) as typeof redis.pipeline;

async function main() {
  redis.clear();
  process.env.STRIPE_SECRET_KEY = "sk_test_a_stand_in_key_for_tests_only";
  process.env.RESEND_API_KEY = "re_a_stand_in_key_for_tests_only";
  who.role = "owner";

  part("The day's count comes back in a shape that cannot be read: 'error', never 'later', nothing recorded");
  const unread = await paidShop({ at: REAL - 2 * DAY });
  who.store = await unread.store();
  world.emails = [];
  reply = ["OK", "1"];
  const unreadState = await post();
  reply = null;
  const unreadAt = (await redisPipeline([["HGET", planWithdrawKey(who.store.sid, unread.subId), "at"]]))[0];
  is("the refund page's 'error' notice (try again), not 'later' and not a bare error", unreadState, "error");
  is("nothing recorded and no receipt", [unreadAt, receipts().length], [null, 0]);

  part("Control: a count past the day's limit still says 'later'");
  const over = await paidShop({ at: REAL - 3 * DAY });
  who.store = await over.store();
  world.emails = [];
  reply = [null, 9_999];
  const overState = await post();
  reply = null;
  is("too many today", [overState, receipts().length], ["later", 0]);

  part("Control: a count within the limit records the statement");
  const fine = await paidShop({ at: REAL - 4 * DAY });
  who.store = await fine.store();
  world.emails = [];
  const fineState = await post();
  const fineAt = (await redisPipeline([["HGET", planWithdrawKey(who.store.sid, fine.subId), "at"]]))[0];
  is("recorded (not 'error', not 'later')", [typeof fineAt, fineState === "error" || fineState === "later"], ["string", false]);

  done();
}

main();
