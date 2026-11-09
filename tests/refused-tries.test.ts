/**
 * How many times one email may be refused for certain (lib/refused-tries.ts).
 *
 * Since a stop before any request is a certain refusal (sendEmailOutcome,
 * "posted: false", #3377), an email can be refused after the store's figure
 * was taken for it (the guard's deadline passed before the fetch; a 4xx after
 * the request). A job that lets its mark go on a refusal asks again on its
 * next run and takes the figure again, with no end. #3377 bounded its own
 * checkout reminders at REFUSED_TRIES (3); this is that count, shared, so
 * every caller that asks again on a refusal stops at the same number.
 * Synthetic Redis (tests/redis-stub.ts); no email is sent.
 */
import { REFUSED_MAX_SECONDS, REFUSED_TRIES, countRefusal, refusedTooOften } from "@/lib/refused-tries";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";

async function main(): Promise<void> {
  redis.clear();

  part("Three refusals at the most, as #3377's checkout reminders");
  is("the limit is #3377's", REFUSED_TRIES, 3);
  is("an email never refused may be tried", await refusedTooOften("dun:acct_1:in_1"), false);
  is("the first refusal leaves room for another try", await countRefusal("dun:acct_1:in_1"), true);
  is("the second too", await countRefusal("dun:acct_1:in_1"), true);
  is("after two it may still be tried", await refusedTooOften("dun:acct_1:in_1"), false);
  is("the third leaves none", await countRefusal("dun:acct_1:in_1"), false);
  is("after three it is not tried again", await refusedTooOften("dun:acct_1:in_1"), true);
  is("a fourth (one tried without asking first) leaves none either", await countRefusal("dun:acct_1:in_1"), false);
  is("another email keeps its own count", await refusedTooOften("dun:acct_1:in_2"), false);

  part("Its key: one family, no address in its name, gone by itself");
  const keys = redis.keys().filter((k) => k.startsWith("nl:refused:"));
  is("one key for the one email counted", keys.length, 1);
  is("named by a hash, never by what it was given (an address stays out of the key)", /^nl:refused:[0-9a-f]{32}$/.test(keys[0] ?? ""), true);
  const ttl = redis.run(["TTL", keys[0]]) as number;
  is("kept a day by default", ttl > 86_390 && ttl <= 86_400, true);
  await countRefusal("payreq:auto:r1:1", 45 * 86_400);
  const long = redis.keys().find((k) => k.startsWith("nl:refused:") && k !== keys[0])!;
  is("kept as long as asked, within the family's most", (redis.run(["TTL", long]) as number) > 45 * 86_400 - 10, true);
  await countRefusal("too-long", 400 * 86_400);
  const capped = redis.keys().filter((k) => k.startsWith("nl:refused:")).map((k) => redis.run(["TTL", k]) as number);
  is("never past REFUSED_MAX_SECONDS", capped.every((s) => s <= REFUSED_MAX_SECONDS), true);

  part("A count that does not read is the limit (rule 24): nothing more is taken");
  const key = keys[0];
  redis.run(["SET", key, "not a number"]);
  is("an unreadable count is too often", await refusedTooOften("dun:acct_1:in_1"), true);
  redis.clear();
  const pipeline = redis.pipeline;
  redis.pipeline = async () => { throw new Error("synthetic: Redis is down"); };
  try {
    is("a failed read is too often", await refusedTooOften("x"), true);
    is("a failed count leaves no room", await countRefusal("x"), false);
  } finally {
    redis.pipeline = pipeline;
  }
  redis.pipeline = async () => [1];
  try {
    is("a count cut short leaves no room", await countRefusal("x"), false);
  } finally {
    redis.pipeline = pipeline;
  }
}

main().then(done, (error) => {
  console.error(error);
  process.exitCode = 1;
});
