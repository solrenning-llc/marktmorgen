/**
 * A sequence step taken off the queue is never lost on a lost reply (lib/flows.ts, sendDueSteps; CX-123 rule 24).
 *
 * The sender took due runs off the queue (ZREM) and only then wrote their lease (ZADD), reading the ZREM counts.
 * A reply lost after the ZREM landed, or answered in another shape, left the run in neither the queue nor the lease:
 * its next steps never went out and nothing said so. Whatever the reply, a run is always in one of the two, so the
 * next run's orphan pass (or the queue itself) picks it up.
 */
import { sendDueSteps } from "@/lib/flows";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";

const QUEUE = "nl:mail:flowq";
const LEASE = "nl:mail:flowq:lease";
const pipeline = redis.pipeline.bind(redis);
const member = "list000001|harbor|0123456789abcdef|0|reader@example.com";

/** Whether the run is anywhere the sender looks: the queue or the lease. */
async function kept(): Promise<boolean> {
  const [inQueue, inLease] = await pipeline([["ZSCORE", QUEUE, member], ["ZSCORE", LEASE, member]]);
  return inQueue !== null || inLease !== null;
}

/** Applies the first command batch that takes the run off the queue, then answers it with `reply` (or throws). */
function loseTakeReply(reply: "throw" | unknown[]) {
  let armed = true;
  redis.pipeline = (async (commands: (string | number)[][]) => {
    const takes = commands.some((c) => (c[0] === "ZREM" && c[1] === QUEUE) || (c[0] === "EVAL" && String(c[1]).includes("marktmorgen:flow-move") && c[3] === QUEUE));
    const results = await pipeline(commands);
    if (armed && takes) {
      armed = false;
      if (reply === "throw") throw new Error("synthetic lost reply");
      return reply as never;
    }
    return results;
  }) as typeof redis.pipeline;
}

async function main(): Promise<void> {
  for (const [label, reply] of [
    ["the reply is lost after the take landed", "throw"],
    ["the reply comes back empty", []],
    ["the reply comes back in another shape", ["OK"]],
  ] as const) {
    part(label);
    redis.pipeline = pipeline;
    redis.clear();
    await pipeline([["ZADD", QUEUE, Math.floor(Date.now() / 1000) - 5, member]]);
    loseTakeReply(reply as "throw" | unknown[]);
    try {
      await sendDueSteps(async () => null, Date.now() + 5_000);
    } catch {
      /* a lost reply may end this run; what matters is where the run is left */
    }
    redis.pipeline = pipeline;
    is("the run is still in the queue or the lease", await kept(), true);
  }

  part("Control: a run whose store is gone is dropped and leaves nothing behind");
  redis.clear();
  await pipeline([["ZADD", QUEUE, Math.floor(Date.now() / 1000) - 5, member]]);
  await sendDueSteps(async () => null, Date.now() + 5_000);
  is("taken and settled", await kept(), false);
}

void main().then(done).catch((error) => { console.error(error); process.exit(1); });
