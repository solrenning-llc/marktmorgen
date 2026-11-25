/**
 * #5285 row #3246, the LEVE of 6726835986: confirmClaim (a paid group booking) recovered each host whose write was not
 * answered as asked one after another, each read-back, retry and read-back in a pipeline of its own: 1 + 3 × hosts
 * pipelines in a row, up to about 95 s with Redis slow, while the mail job that confirms has 60 s and the booking's
 * once-only mark is already set. Every recovery step is now one pipeline for all the hosts that need it, so the number
 * of trips to Redis does not grow with the number of hosts. What it confirms, retries and throws is unchanged.
 *
 * Synthetic host ids; Redis is lib/redis-memory.ts.
 */
import { claimsKey, confirmClaim, newClaimId } from "@/lib/host-claims";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";

/** Six host ids in the 24-hex shape, the most a team booking has (readTeamSetup). */
const HOSTS = Array.from({ length: 6 }, (_, i) => "abcdef"[i].repeat(24));
const now = Date.now();
const start = now + 3 * 86_400_000;
const end = start + 3_600_000;
const real = redis.pipeline.bind(redis);

type Plan = (commands: (string | number)[][]) => Promise<unknown[]>;
/** Counts every pipeline sent while `plan` answers it. */
async function trips(run: () => Promise<unknown>, plan: Plan): Promise<{ pipelines: number; threw: boolean }> {
  let pipelines = 0;
  redis.pipeline = (async (commands: (string | number)[][]) => {
    pipelines += 1;
    return plan(commands);
  }) as typeof redis.pipeline;
  const quiet = console.error;
  console.error = () => {};
  try {
    await run();
    return { pipelines, threw: false };
  } catch {
    return { pipelines, threw: true };
  } finally {
    console.error = quiet;
    redis.pipeline = real;
  }
}

const failing: Plan = async () => {
  throw new Error("synthetic Redis timeout");
};
/** The first pipeline's HSET replies come back in a shape that is not a count; everything after runs for real. */
function writeUnanswered(): Plan {
  let first = true;
  return async (commands) => {
    const replies = await real(commands);
    if (!first) return replies;
    first = false;
    return replies.map((reply, i) => (commands[i][0] === "HSET" ? "OK?" : reply));
  };
}

async function main(): Promise<void> {
  part("Every pipeline fails: the trips do not grow with the hosts");
  {
    redis.clear();
    const one = await trips(() => confirmClaim(HOSTS.slice(0, 1), newClaimId(), start, end, "callsA:p1"), failing);
    redis.clear();
    const six = await trips(() => confirmClaim(HOSTS, newClaimId(), start, end, "callsA:p1"), failing);
    is("control: both throw, nothing confirmed", [one.threw, six.threw], [true, true]);
    is("six hosts send no more pipelines than one host", six.pipelines, one.pipelines);
    is("at most four pipelines: the write, then one read-back, one retry and one read-back for all", six.pipelines <= 4, true);
  }

  part("Every write unanswered, the read-backs answered: the hosts are confirmed in a few trips");
  {
    redis.clear();
    const claim = newClaimId();
    const six = await trips(() => confirmClaim(HOSTS, claim, start, end, "callsA:p1"), writeUnanswered());
    is("control: it resolves, every host holds the paid claim", [six.threw, HOSTS.every((id) => String(redis.run(["HGET", claimsKey(id), claim])).startsWith(`${start}|${end}|0|`))], [false, true]);
    redis.clear();
    const oneClaim = newClaimId();
    const one = await trips(() => confirmClaim(HOSTS.slice(0, 1), oneClaim, start, end, "callsA:p1"), writeUnanswered());
    is("six hosts send no more pipelines than one host", six.pipelines, one.pipelines);
  }

  part("Healthy: one pipeline for the write and its lifetimes, one for the lifetimes to set");
  {
    redis.clear();
    const healthy = await trips(() => confirmClaim(HOSTS, newClaimId(), start, end, "callsA:p1"), (commands) => real(commands));
    is("two pipelines, as before", [healthy.threw, healthy.pipelines], [false, 2]);
  }

  done();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
