/**
 * #4681 (Codex G): forgetWelcomePerson deleted the mark that locates a person's reminder before it read the queue. A
 * queue read that failed once lost the mark, and the retry, finding no mark, certified the erasure with the address
 * still queued. The member is now found and removed first; the marks go only after that removal is confirmed.
 * In-memory Redis; no email or provider.
 */
import { createHash } from "node:crypto";
import { forgetWelcomePerson } from "@/lib/welcome-offer-send";
import { store as redis, redisPipeline } from "./redis-stub";
import { done, is, part } from "./check";

process.env.UPSTASH_REDIS_REST_URL ??= "http://stub";

const DUE = "nl:wo:due";
const STATS = "3e762a4eb1d84c7ebe34c54b64158ce3";
const EMAIL = "buyer@example.com";
const hash = createHash("sha256").update(`welcome:${EMAIL}`).digest("hex").slice(0, 32);
const claim = "1700000000.123456789";
const HOUR = "2000000000";
const MEMBER = JSON.stringify({ s: "sid-3e762a", i: STATS, h: hash, e: EMAIL, t: "tok" });

const real = redis.pipeline.bind(redis);
let bendOnce = false;
redis.pipeline = (async (commands: (string | number)[][]) => {
  if (bendOnce && commands.length === 1 && commands[0][0] === "ZRANGEBYSCORE") {
    bendOnce = false;
    return [];
  }
  return real(commands);
}) as typeof redis.pipeline;

const seed = () =>
  redisPipeline([
    ["ZADD", DUE, HOUR, MEMBER],
    ["SET", `nl:wo:start:${STATS}:${hash}`, "1"],
    ["SET", `nl:wo:r:${STATS}:${hash}`, `due:${HOUR}:${claim}`],
  ]);
const left = async () => (await redisPipeline([["ZSCORE", DUE, MEMBER], ["GET", `nl:wo:start:${STATS}:${hash}`], ["GET", `nl:wo:r:${STATS}:${hash}`]])) as unknown[];

async function main(): Promise<void> {
  part("(control) the reminder, its start and its mark all go in one erasure");
  await seed();
  await forgetWelcomePerson(STATS, EMAIL);
  is("nothing of the person is left", await left(), [null, null, null]);
  is("(control) nothing set: nothing to forget", await forgetWelcomePerson(STATS, EMAIL), 0);

  part("A queue read that fails once must not lose the mark that locates the reminder");
  await seed();
  bendOnce = true;
  const first = await forgetWelcomePerson(STATS, EMAIL).then(() => "resolved", () => "rejected");
  is("the first try rejects", first, "rejected");
  is("the mark that locates the reminder is still there", (await left())[2], `due:${HOUR}:${claim}`);
  const second = await forgetWelcomePerson(STATS, EMAIL).then(() => "resolved", () => "rejected");
  is("the retry resolves", second, "resolved");
  is("and nothing of the person is left, the queued address included", await left(), [null, null, null]);
  done();
}
main().catch((error) => {
  console.error(error);
  process.exit(1);
});
