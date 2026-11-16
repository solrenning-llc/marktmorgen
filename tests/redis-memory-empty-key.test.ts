/**
 * The in-memory Redis (lib/redis-memory.ts) keeps no empty collection, as Redis
 * does: reading a list, hash, set or sorted set that is not there makes no key,
 * and a collection whose last member goes is deleted. Before, a read such as
 * ZRANGEBYSCORE of a missing key made an empty one, so a DEL after it answered
 * 1 instead of Redis's 0, and a count built from DEL replies was off by one
 * (community-erasure-member-last on #2957: lib/community-approval.ts
 * forgetHeldPerson reads the member's held list, then deletes it).
 */
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";

redis.clear();

part("A read of a missing collection makes no key: a DEL after it answers 0");
for (const read of [
  ["ZRANGEBYSCORE", "nl:test:empty:z", "-inf", "+inf"],
  ["ZCARD", "nl:test:empty:z3"],
  ["ZSCORE", "nl:test:empty:z4", "a"],
  ["HGETALL", "nl:test:empty:h"],
  ["HGET", "nl:test:empty:h2", "a"],
  ["HLEN", "nl:test:empty:h3"],
  ["SMEMBERS", "nl:test:empty:s"],
  ["SISMEMBER", "nl:test:empty:s2", "a"],
  ["SCARD", "nl:test:empty:s3"],
  ["LRANGE", "nl:test:empty:l", 0, -1],
  ["LLEN", "nl:test:empty:l2"],
] as (string | number)[][]) {
  const key = String(read[1]);
  redis.run(read);
  is(`${read[0]}: no key left behind`, redis.keys().includes(key), false);
  is(`${read[0]}: EXISTS answers 0`, redis.run(["EXISTS", key]), 0);
  is(`${read[0]}: DEL answers 0`, redis.run(["DEL", key]), 0);
}

part("The commands of #2957's probe answer as Redis does");
is("[DEL x, ZRANGEBYSCORE y, DEL y]", [["DEL", "nl:test:x"], ["ZRANGEBYSCORE", "nl:test:y", "-inf", "+inf"], ["DEL", "nl:test:y"]].map((c) => redis.run(c)), [0, [], 0]);

part("A collection whose last member goes is deleted");
redis.run(["ZADD", "nl:test:last:z", 1, "a"]);
is("ZREM of the last member", redis.run(["ZREM", "nl:test:last:z", "a"]), 1);
is("the sorted set is gone", redis.run(["EXISTS", "nl:test:last:z"]), 0);
redis.run(["HSET", "nl:test:last:h", "f", "v"]);
redis.run(["HDEL", "nl:test:last:h", "f"]);
is("the hash is gone", redis.run(["EXISTS", "nl:test:last:h"]), 0);
redis.run(["SADD", "nl:test:last:s", "a"]);
redis.run(["SREM", "nl:test:last:s", "a"]);
is("the set is gone", redis.run(["EXISTS", "nl:test:last:s"]), 0);

part("Controls: a collection with members is kept and deleted as before");
redis.run(["ZADD", "nl:test:kept:z", 1, "a", 2, "b"]);
redis.run(["ZREM", "nl:test:kept:z", "a"]);
is("one member left: still there", redis.run(["EXISTS", "nl:test:kept:z"]), 1);
is("DEL of it answers 1", redis.run(["DEL", "nl:test:kept:z"]), 1);
redis.run(["HSET", "nl:test:kept:h", "f", "v"]);
is("HGETALL of a hash with a field", redis.run(["HGETALL", "nl:test:kept:h"]), ["f", "v"]);
is("DEL of the hash answers 1", redis.run(["DEL", "nl:test:kept:h"]), 1);

done();
