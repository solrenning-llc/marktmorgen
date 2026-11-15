/**
 * Proof, Claude 5 (privacy, rule 30 sibling): the welcome offer's reminder
 * waiting for its hour (lib/welcome-offer-send.ts, the "nl:wo:due" sorted set)
 * holds the person's address in its member. forgetWelcomePerson, the erasure
 * part for the welcome offer (lib/person-erasure.ts), deleted only when the
 * offer began and that the reminder was set, so the address stayed in the
 * queue until the reminder's hour.
 * Expected: after the erasure, no member of the queue names that person in
 * that store; another person's reminder and the same person's in another store
 * stay; what was taken out is counted in the receipt; a scan or removal reply
 * of another shape rejects, so the part is said as not finished.
 */
import { createHash } from "node:crypto";
import { forgetWelcomePerson } from "@/lib/welcome-offer-send";
import { store as redis, redisPipeline } from "./redis-stub";
import { done, is } from "./check";

process.env.UPSTASH_REDIS_REST_URL ??= "http://stub";

const DUE = "nl:wo:due";
const STATS = "3e762a4eb1d84c7ebe34c54b64158ce3";
const OTHER_STATS = "9a0c4f2e7d1b48e6a5c3f0b2d4e6a8c0";
const EMAIL = "buyer@example.com";
const hash = (email: string) => createHash("sha256").update(`welcome:${email.toLowerCase()}`).digest("hex").slice(0, 32);
const member = (statsId: string, email: string, token: string) => JSON.stringify({ s: `sid-${statsId.slice(0, 6)}`, i: statsId, h: hash(email), e: email, t: token });

let bad: { command: string; reply: unknown } | null = null;
const pipeline = redis.pipeline.bind(redis);
redis.pipeline = (async (commands: (string | number)[][]) => {
  if (bad && commands.length === 1 && commands[0]?.[0] === bad.command) return bad.reply as unknown[];
  return pipeline(commands);
}) as typeof redis.pipeline;

async function outcome(run: () => Promise<unknown>): Promise<unknown> {
  try {
    return await run();
  } catch (error) {
    return `rejected: ${error instanceof Error ? error.name : "?"}`;
  }
}

async function queued(): Promise<string[]> {
  const [all] = await redisPipeline([["ZRANGEBYSCORE", DUE, "-inf", "+inf"]]);
  return (all as string[]).slice().sort();
}

async function seed(): Promise<void> {
  await redisPipeline([["DEL", DUE]]);
  await redisPipeline([
    ["ZADD", DUE, "2000000000", member(STATS, EMAIL, "tok-mine")],
    ["ZADD", DUE, "2000000100", member(STATS, "someone@example.com", "tok-theirs")],
    ["ZADD", DUE, "2000000200", member(OTHER_STATS, EMAIL, "tok-other-store")],
    ["SET", `nl:wo:start:${STATS}:${hash(EMAIL)}`, "1"],
    ["SET", `nl:wo:r:${STATS}:${hash(EMAIL)}`, "1"],
  ]);
}

void (async () => {
  await seed();
  const removed = await forgetWelcomePerson(STATS, "Buyer@Example.com");
  const left = await queued();
  is("the erased person's address is no longer in the reminder queue", left.filter((m) => m.includes(EMAIL) && m.includes(STATS)), []);
  is(
    "another person's reminder and the same person's in another store stay",
    left,
    [member(OTHER_STATS, EMAIL, "tok-other-store"), member(STATS, "someone@example.com", "tok-theirs")].sort(),
  );
  is("the receipt counts the two marks and the reminder taken out", removed, 3);
  is("nothing left to take out the second time", await forgetWelcomePerson(STATS, EMAIL), 0);

  const SCAN_BAD: [string, unknown][] = [
    ["null", [null]],
    ["not a pair", [["0"]]],
    ["cursor not text", [[0, []]]],
    ["members not a list", [["0", "x"]]],
    ["odd member and score list", [["0", ["a"]]]],
    ["a member not text", [["0", [1, "2"]]]],
    ["no reply", []],
  ];
  for (const [label, reply] of SCAN_BAD) {
    await seed();
    bad = { command: "ZSCAN", reply };
    is(`a queue scan answered ${label}: the part is not finished`, await outcome(() => forgetWelcomePerson(STATS, EMAIL)), "rejected: UnknownReplyError");
    bad = null;
  }
  const ZREM_BAD: [string, unknown][] = [
    ["null", [null]],
    ["text", ["1"]],
    ["more than asked", [2]],
    ["negative", [-1]],
    ["no reply", []],
  ];
  for (const [label, reply] of ZREM_BAD) {
    await seed();
    bad = { command: "ZREM", reply };
    is(`the removal from the queue answered ${label}: the part is not finished`, await outcome(() => forgetWelcomePerson(STATS, EMAIL)), "rejected: UnknownReplyError");
    bad = null;
  }
  done();
})();
