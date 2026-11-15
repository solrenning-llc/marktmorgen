/**
 * The in-memory Redis (lib/redis-memory.ts) read a sorted set through one helper that made the key when it was missing
 * and replaced a key of another kind with an empty set. Redis does neither: a read or a removal of members on a
 * missing key makes nothing, a key of another kind answers WRONGTYPE and is kept, and a set whose last member goes is
 * deleted. Checked against redis-server 7 on 15 November 2026 (C7). A test could pass on the stand-in because a read
 * made a key, or because a value of another kind was silently emptied.
 */
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";

const run = async (command: (string | number)[]): Promise<unknown> => {
  try {
    return (await redis.pipeline([command]))[0];
  } catch (error) {
    return String(error instanceof Error ? error.message : error).split(" ")[0];
  }
};
const exists = async (key: string) => (await redis.pipeline([["EXISTS", key]]))[0];

async function main(): Promise<void> {
  part("On a missing key: the answer Redis gives, and no key made");
  const reads: [string, (string | number)[], unknown][] = [
    ["ZSCORE", ["ZSCORE", "nk", "m"], null],
    ["ZCARD", ["ZCARD", "nk"], 0],
    ["ZCOUNT", ["ZCOUNT", "nk", "-inf", "+inf"], 0],
    ["ZRANGEBYSCORE", ["ZRANGEBYSCORE", "nk", "-inf", "+inf"], []],
    ["ZREVRANGEBYSCORE", ["ZREVRANGEBYSCORE", "nk", "+inf", "-inf"], []],
    ["ZREVRANGE", ["ZREVRANGE", "nk", 0, -1], []],
    ["ZREVRANK", ["ZREVRANK", "nk", "m"], null],
    ["ZREM", ["ZREM", "nk", "m"], 0],
    ["ZREMRANGEBYSCORE", ["ZREMRANGEBYSCORE", "nk", "-inf", "+inf"], 0],
    ["ZREMRANGEBYRANK", ["ZREMRANGEBYRANK", "nk", 0, -1], 0],
    ["ZSCAN", ["ZSCAN", "nk", 0], ["0", []]],
  ];
  for (const [name, command, answer] of reads) {
    redis.clear();
    is(`${name}: answers as Redis`, await run(command), answer);
    is(`${name}: makes no key`, await exists("nk"), 0);
  }

  part("On a key of another kind: WRONGTYPE, and the value kept");
  for (const [name, command] of [
    ["ZSCORE", ["ZSCORE", "s", "m"]],
    ["ZCARD", ["ZCARD", "s"]],
    ["ZRANGEBYSCORE", ["ZRANGEBYSCORE", "s", "-inf", "+inf"]],
    ["ZREVRANGE", ["ZREVRANGE", "s", 0, -1]],
    ["ZREM", ["ZREM", "s", "m"]],
    ["ZADD", ["ZADD", "s", 1, "m"]],
    ["ZINCRBY", ["ZINCRBY", "s", 1, "m"]],
    ["ZUNIONSTORE source", ["ZUNIONSTORE", "d", 1, "s"]],
  ] as [string, (string | number)[]][]) {
    redis.clear();
    await redis.pipeline([["SET", "s", "x"]]);
    is(`${name}: WRONGTYPE`, await run(command), "WRONGTYPE");
    is(`${name}: the string is kept`, (await redis.pipeline([["GET", "s"]]))[0], "x");
  }

  part("A sorted set whose last member goes is deleted, as on Redis");
  for (const [name, command] of [
    ["ZREM", ["ZREM", "z", "a"]],
    ["ZREMRANGEBYSCORE", ["ZREMRANGEBYSCORE", "z", "-inf", "+inf"]],
    ["ZREMRANGEBYRANK", ["ZREMRANGEBYRANK", "z", 0, -1]],
  ] as [string, (string | number)[]][]) {
    redis.clear();
    await redis.pipeline([["ZADD", "z", 1, "a"]]);
    is(`${name}: removes the one member`, await run(command), 1);
    is(`${name}: the key is gone`, await exists("z"), 0);
  }

  part("ZUNIONSTORE and ZINTERSTORE with an empty result delete the destination, as on Redis");
  for (const [name, command] of [
    ["ZUNIONSTORE of a missing source", ["ZUNIONSTORE", "d", 1, "nk"]],
    ["ZINTERSTORE of two sets with nothing in common", ["ZINTERSTORE", "d", 2, "a", "b"]],
  ] as [string, (string | number)[]][]) {
    redis.clear();
    await redis.pipeline([["SET", "d", "x"], ["EXPIRE", "d", 100], ["ZADD", "a", 1, "m"], ["ZADD", "b", 1, "n"]]);
    is(`${name}: answers 0`, await run(command), 0);
    is(`${name}: the destination is gone`, await exists("d"), 0);
  }

  // Reviewer 3rjdf against Redis 7.0.15 (15 November 2026).
  part("ZADD XX on a missing key adds nothing and makes no key");
  redis.clear();
  is("answers 0", await run(["ZADD", "nk", "XX", 1, "m"]), 0);
  is("no key", await exists("nk"), 0);

  part("A plain set is a source of ZUNIONSTORE and ZINTERSTORE, each member at score 1");
  redis.clear();
  await redis.pipeline([["SADD", "s", "a", "b"], ["ZADD", "z", 5, "a"]]);
  is("ZUNIONSTORE of a set and a sorted set", [await run(["ZUNIONSTORE", "d", 2, "s", "z"]), await run(["ZRANGEBYSCORE", "d", "-inf", "+inf", "WITHSCORES"])], [2, ["b", "1", "a", "6"]]);
  is("ZINTERSTORE of a set and a sorted set", [await run(["ZINTERSTORE", "d2", 2, "s", "z"]), await run(["ZRANGEBYSCORE", "d2", "-inf", "+inf", "WITHSCORES"])], [1, ["a", "6"]]);
  is("ZINTERSTORE with the sorted set first", [await run(["ZINTERSTORE", "d3", 2, "z", "s"]), await run(["ZRANGEBYSCORE", "d3", "-inf", "+inf", "WITHSCORES"])], [1, ["a", "6"]]);

  part("ZADD with GT, LT or INCR is refused by name, never written as a score that is not a number");
  for (const flag of ["GT", "LT", "INCR"]) {
    redis.clear();
    await redis.pipeline([["ZADD", "z", 1, "a"]]);
    const said = await run(["ZADD", "z", flag, 2, "a"]);
    is(`${flag}: refused by name`, typeof said === "string" && said !== "WRONGTYPE" && String(said).length > 0, true);
    is(`${flag}: the score is kept`, await run(["ZSCORE", "z", "a"]), "1");
  }

  part("Control: a sorted set that exists reads and writes as before");
  redis.clear();
  await redis.pipeline([["ZADD", "z", 2, "b", 1, "a"]]);
  is("ZRANGEBYSCORE", await run(["ZRANGEBYSCORE", "z", "-inf", "+inf"]), ["a", "b"]);
  is("ZSCORE", await run(["ZSCORE", "z", "b"]), "2");
  is("ZREM of one keeps the other", [await run(["ZREM", "z", "a"]), await run(["ZCARD", "z"])], [1, 1]);
  done();
}
main().catch((error) => { console.error(error); process.exit(1); });
