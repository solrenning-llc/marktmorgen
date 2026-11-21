/**
 * A run puts back only its own take of the lease (lib/flows.ts, sendDueSteps' putBack, FLOW_MOVE_OWN; Claude 6 on
 * #2287, 6909223619). Run A takes a step off the queue at its own score (leaseScore); its lease runs out, the orphan
 * pass returns the step to the queue, and run B takes it again at another score. When A then puts its steps back
 * (here: A ran out of time), B's entry stays in the lease and is not returned to the queue, where a third run would
 * take and send it again while B is still sending it. Control: with no other run, A's own step goes back to the queue.
 * Synthetic data only: the in-memory Redis (tests/redis-stub.ts); no store is loaded and nothing is sent.
 */
import { LEASE_SECONDS, sendDueSteps } from "@/lib/flows";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";

const QUEUE = "nl:mail:flowq";
const LEASE = "nl:mail:flowq:lease";
const pipeline = redis.pipeline.bind(redis);
const realNow = Date.now;
const member = "list000001|harbor|0123456789abcdef|0|reader@example.com";

/** Where the step is: its score in the queue and in the lease, null where it is not. */
async function where(): Promise<{ queue: number | null; lease: number | null }> {
  const [queue, lease] = await pipeline([["ZSCORE", QUEUE, member], ["ZSCORE", LEASE, member]]);
  return { queue: queue === null ? null : Number(queue), lease: lease === null ? null : Number(lease) };
}

/**
 * Lets A's take of the queue land, then runs `meanwhile` (what happens before A puts its steps back) and moves the
 * clock past A's deadline, so A puts back what it took instead of sending it.
 */
function afterTake(deadline: number, meanwhile: () => Promise<void>) {
  let armed = true;
  redis.pipeline = (async (commands: (string | number)[][]) => {
    const takes = commands.some((c) => c[0] === "EVAL" && String(c[1]).startsWith("-- marktmorgen:flow-move:") && c[3] === QUEUE);
    const results = await pipeline(commands);
    if (armed && takes) {
      armed = false;
      await meanwhile();
      Date.now = () => deadline + 1_000;
    }
    return results;
  }) as typeof redis.pipeline;
}

async function main(): Promise<void> {
  try {
    part("Run B took the step over after A's lease ran out: A's put-back leaves B's entry alone");
    redis.clear();
    await pipeline([["ZADD", QUEUE, Math.floor(realNow() / 1000) - 5, member]]);
    const deadline = realNow() + 5_000;
    // B's own score: a whole lease from now, at a fraction no take of A's draws (leaseScore's is below a half).
    const bScore = Math.floor(realNow() / 1000) + LEASE_SECONDS + 0.75;
    let aScore: number | null = null;
    afterTake(deadline, async () => {
      aScore = (await where()).lease;
      // A's lease ran out; the orphan pass puts the step back on the queue; B takes it at its own score.
      await pipeline([["ZREM", LEASE, member], ["ZADD", QUEUE, Math.floor(realNow() / 1000), member]]);
      await pipeline([["ZREM", QUEUE, member], ["ZADD", LEASE, bScore, member]]);
    });
    await sendDueSteps(async () => null, deadline);
    redis.pipeline = pipeline;
    Date.now = realNow;
    is("(control) A took the step at a score of its own, not B's", aScore !== null && aScore !== bScore, true);
    const after = await where();
    is("B's entry is still in the lease, at B's score", after.lease, bScore);
    is("and the step is not back on the queue", after.queue, null);

    part("Control: no other run took it, so A puts its own step back on the queue");
    redis.clear();
    await pipeline([["ZADD", QUEUE, Math.floor(realNow() / 1000) - 5, member]]);
    const second = realNow() + 5_000;
    afterTake(second, async () => undefined);
    await sendDueSteps(async () => null, second);
    redis.pipeline = pipeline;
    Date.now = realNow;
    const back = await where();
    is("back on the queue", back.queue !== null, true);
    is("and out of the lease", back.lease, null);
  } finally {
    redis.pipeline = pipeline;
    Date.now = realNow;
  }
}

void main().then(done).catch((error) => {
  console.error(error);
  process.exit(1);
});
