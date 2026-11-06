/**
 * Sweep A5 proof (CX-123 rule 24), synthetic only. lib/plan-refund-underway.ts refundUnderway, lines 13-19:
 *   const [noted, running] = await redisPipeline([["HEXISTS", ENDING_KEY, sid], ["EXISTS", flowKeyOf(sid)]]);
 *   return Number(noted) === 1 || Number(running) === 1;
 * Its own doc says an unreadable store is treated as underway, never as settled; the callers only do that for a
 * throw (`.catch(() => true)`, app/api/billing/refund/route.ts:48, app/studio/refund/page.tsx:61). A reply cut short
 * or of another shape answers "not underway": after a request that failed part way with a note left (money may have
 * moved), the route answers "error" instead of "unsure" (route.ts:58, :66), and the review page shows a fresh
 * confirmation.
 */
import { ENDING_KEY, flowKeyOf } from "@/lib/plan-refund-flow";
import { refundUnderway } from "@/lib/plan-refund-underway";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";

const sid = "0123456789abcdef0123456789abcdef";
const original = redis.pipeline.bind(redis);

async function main() {
  redis.clear();
  await redis.pipeline([["HSET", ENDING_KEY, sid, JSON.stringify({ s: "sub_x", at: 1, t: 1, m: 1 })], ["SET", flowKeyOf(sid), "held", "EX", 60]]);
  part("Healthy control: a note and a running request: underway");
  is("underway", await refundUnderway(sid), true);

  part("DEFECT: the same store, the two replies answered in an unknown shape");
  for (const [label, reply] of [["no reply", []], ["text", ["yes", "yes"]], ["objects", [{}, {}]]] as const) {
    redis.pipeline = (async (commands: (string | number)[][]) => (commands[0]?.[0] === "HEXISTS" && commands[0][1] === ENDING_KEY ? reply : original(commands))) as typeof redis.pipeline;
    let threw = false;
    const answer = await refundUnderway(sid).catch(() => { threw = true; return true; });
    redis.pipeline = original;
    is(`DEFECT (${label}): answered "settled" without throwing`, [answer, threw], [false, false]);
  }
  is("while the note is still there", (await redis.pipeline([["HEXISTS", ENDING_KEY, sid]]))[0], 1);
  done();
}
main();
