/**
 * Whether a plan refund is still being settled, read in an unknown shape
 * (rule 24). Read as "not underway", the review page offered a new
 * confirmation and the route could say "Nothing was refunded" while a
 * refund may have been made. Unknown now throws, which both callers already
 * take as underway (catch(() => true)).
 * Synthetic only: the Redis stub.
 */
import { refundUnderway } from "@/lib/plan-refund-underway";
import { ENDING_KEY, flowKeyOf } from "@/lib/plan-refund-flow";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";

const SID = "0123456789abcdef0123456789abcdef";
const real = redis.pipeline.bind(redis);

async function outcome(reply: unknown[]): Promise<boolean | "rejected"> {
  redis.pipeline = (async () => [...reply]) as typeof redis.pipeline;
  try {
    return await refundUnderway(SID);
  } catch {
    return "rejected";
  } finally {
    redis.pipeline = real;
  }
}

async function main(): Promise<void> {
  redis.clear();
  part("Unknown answers are never 'not underway'");
  for (const [label, reply] of [
    ["no reply", []], ["one reply", [0]], ["three replies", [0, 0, 0]], ["undefined", [undefined, undefined]],
    ["text", ["0", "0"]], ["a negative count", [-1, 0]], ["a count of two", [0, 2]], ["null", [null, 0]],
  ] as const) is(label, await outcome([...reply]), "rejected");

  part("Controls");
  is("nothing noted, nothing running: not underway", await refundUnderway(SID), false);
  await real([["HSET", ENDING_KEY, SID, "1"]]);
  is("a note: underway", await refundUnderway(SID), true);
  await real([["HDEL", ENDING_KEY, SID], ["SET", flowKeyOf(SID), "1"]]);
  is("a request running: underway", await refundUnderway(SID), true);
  done();
}

void main();
