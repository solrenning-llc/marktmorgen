/**
 * A retry of the welcome offer's erasure part still finds the reminder that a
 * first, unfinished try left in the queue (Claude 3 cloud I, erasure audit
 * 14/11/2026).
 *
 * forgetWelcomePerson deleted the reminder mark (nl:wo:r:, which keeps the
 * reminder's hour) before taking the reminder out of nl:wo:due. When that
 * removal answered in an unknown shape, the part was rightly said as not
 * finished; but the mark was already gone, so the retry read no hour, found
 * nothing to take out and answered done, while the reminder, holding the
 * person's address, stayed queued until its hour. Synthetic data only.
 */
import { createHash } from "node:crypto";
import { forgetWelcomePerson } from "@/lib/welcome-offer-send";
import { store as redis, redisPipeline } from "./redis-stub";
import { done, is } from "./check";

process.env.UPSTASH_REDIS_REST_URL ??= "http://stub";

const DUE = "nl:wo:due";
const STATS = "3e762a4eb1d84c7ebe34c54b64158ce3";
const EMAIL = "buyer@example.com";
const HOUR = "2000000000";
const hash = (email: string) => createHash("sha256").update(`welcome:${email.toLowerCase()}`).digest("hex").slice(0, 32);
const mine = JSON.stringify({ s: `sid-${STATS.slice(0, 6)}`, i: STATS, h: hash(EMAIL), e: EMAIL, t: "tok-mine" });

let bad: unknown[] | null = null;
const pipeline = redis.pipeline.bind(redis);
redis.pipeline = (async (commands: (string | number)[][]) => {
  if (bad && commands.length === 1 && commands[0]?.[0] === "ZREM") return bad;
  return pipeline(commands);
}) as typeof redis.pipeline;

async function outcome(run: () => Promise<unknown>): Promise<unknown> {
  try {
    return await run();
  } catch (error) {
    return `rejected: ${error instanceof Error ? error.name : "?"}`;
  }
}

void (async () => {
  for (const mark of [`due:${HOUR}:1700000000.123456789`, "1"]) {
    await redisPipeline([["DEL", DUE]]);
    await redisPipeline([
      ["ZADD", DUE, HOUR, mine],
      ["SET", `nl:wo:start:${STATS}:${hash(EMAIL)}`, "1"],
      ["SET", `nl:wo:r:${STATS}:${hash(EMAIL)}`, mark],
    ]);
    bad = [null];
    is(`mark ${mark.slice(0, 4)}: a first try whose queue removal is unknown is not finished`, await outcome(() => forgetWelcomePerson(STATS, EMAIL)), "rejected: UnknownReplyError");
    bad = null;
    await outcome(() => forgetWelcomePerson(STATS, EMAIL));
    const [left] = await redisPipeline([["ZRANGEBYSCORE", DUE, "-inf", "+inf"]]);
    is(`mark ${mark.slice(0, 4)}: the retry takes the reminder, with the address, out of the queue`, (left as string[]).filter((m) => m.includes(EMAIL)), []);
  }
  done();
})();
