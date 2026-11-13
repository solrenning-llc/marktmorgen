// A payment plan's checkout is written down (lib/plans.ts, rememberPlan) before the
// buyer leaves for Stripe, so the plan is given its end even if they never come back.
// Only an exact SADD reply (one reply, 0 or 1) counts as written down; any other shape
// throws before the checkout URL is handed out, so a plan is never left without its end
// (issue #4287, item 15; Codex X5).
import { rememberPlan } from "@/lib/plans";
import { UnknownReplyError } from "@/lib/redis-reply";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";

const ACCOUNT = "acct_1TestPlansExact1";
const SESSION = "cs_test_planpendingexact01";

async function outcome(): Promise<string> {
  try {
    await rememberPlan(ACCOUNT, SESSION);
    return "kept";
  } catch (error) {
    return error instanceof UnknownReplyError ? "unknown" : `other: ${String(error)}`;
  }
}

async function main(): Promise<void> {
  const run = redis.pipeline.bind(redis);

  part("Control: Redis answers the SADD");
  redis.clear();
  is("written down", await outcome(), "kept");
  is("the pending set holds it", (await run([["SMEMBERS", "nl:plans:pending"]]))[0].length, 1);
  is("written again: SADD answers 0, still written down", await outcome(), "kept");

  for (const [name, reply] of [
    ["no reply at all", [] as unknown[]],
    ["two replies for one command", [1, 1]],
    ["a reply of 2", [2]],
    ["a string", ["1"]],
    ["null", [null]],
  ] as const) {
    part(`Off-spec: ${name}`);
    redis.clear();
    redis.pipeline = async (commands: unknown[][]) => {
      await run(commands as never);
      return reply as never;
    };
    is("not taken as written down", await outcome(), "unknown");
    redis.pipeline = run;
  }
  done();
}
main().catch((error) => { console.error(error); process.exit(1); });
