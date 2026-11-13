/**
 * Synthetic only (#4352, Codex X5): a payment plan's place in the pending queue is confirmed before the checkout hands
 * the buyer the payment link. An SADD answered in an unknown shape is checked with an exact read of the very entry; a
 * plan whose entry is not there refuses the checkout, so no plan is paid that the cron cannot end.
 *
 * Checks marked [CORRETO] say what should happen; a FAIL there is the defect.
 */
import { rememberPlan } from "@/lib/plans";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";

const ACCOUNT = "acct_1TestPlans0001";
const original = redis.pipeline;
const pending = () => redis.run(["SMEMBERS", "nl:plans:pending"]) as string[];

/** Runs `run` with the queue's SADD answered by `answer` (after running it when `ran`). */
async function withSadd<T>(answer: () => unknown, ran: boolean, run: () => Promise<T>): Promise<T> {
  redis.pipeline = (async (commands: (string | number)[][]) => {
    if (commands[0]?.[0] === "SADD" && commands[0]?.[1] === "nl:plans:pending") {
      if (ran) await original(commands);
      return answer();
    }
    return original(commands);
  }) as typeof redis.pipeline;
  try {
    return await run();
  } finally {
    redis.pipeline = original;
  }
}

async function outcome(run: () => Promise<void>): Promise<"ok" | "refused"> {
  try {
    await run();
    return "ok";
  } catch {
    return "refused";
  }
}

async function main(): Promise<void> {
  process.env.UPSTASH_REDIS_REST_URL ??= "http://stub";

  part("An SADD answered with an empty reply list and not stored (the issue's case)");
  redis.clear();
  is("[CORRETO] rememberPlan refuses the checkout", await outcome(() => withSadd(() => [], false, () => rememberPlan(ACCOUNT, "cs_test_plan00000009"))), "refused");
  is("the session is not in the pending set", pending(), []);

  part("An SADD that stored the entry but whose answer was lost");
  redis.clear();
  is("[CORRETO] the entry read back exactly lets the checkout go on", await outcome(() => withSadd(() => [{ error: "unknown" }], true, () => rememberPlan(ACCOUNT, "cs_test_plan00000010"))), "ok");
  is("the session is in the pending set once", pending().filter((m) => m.startsWith(`${ACCOUNT}|cs_test_plan00000010|`)).length, 1);

  part("An SADD that failed outright and stored nothing");
  redis.clear();
  is("[CORRETO] rememberPlan refuses the checkout", await outcome(() => withSadd(() => { throw new Error("Redis request failed with status 503"); }, false, () => rememberPlan(ACCOUNT, "cs_test_plan00000011"))), "refused");

  part("The ordinary write");
  redis.clear();
  is("a confirmed SADD goes on", await outcome(() => rememberPlan(ACCOUNT, "cs_test_plan00000012")), "ok");
  is("and the session is pending", pending().length, 1);
  done();
}

void main();
