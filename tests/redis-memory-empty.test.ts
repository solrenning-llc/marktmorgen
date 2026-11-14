/**
 * The in-memory Redis (lib/redis-memory.ts) keeps no empty collection, as
 * Redis does: a hash, set, sorted set or list whose last member goes is gone,
 * and a read of a missing one leaves nothing behind. Before this, a read
 * (HGET, SISMEMBER, ZSCORE, LRANGE...) made an empty key, so a later DEL
 * answered 1 where Redis answers 0, and EXISTS, TYPE and SCAN saw a key no
 * server would have. lib/person-erasure.ts forgetHeldPerson (543 [CM2]) counts
 * its DELs, which made #2957 and #2576 fail in the stand-in only.
 */
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";

redis.clear();

part("A read of a missing collection leaves nothing behind");
const reads: [string, (string | number)[]][] = [
  ["HGET", ["HGET", "nl:t:h", "f"]],
  ["HGETALL", ["HGETALL", "nl:t:h2"]],
  ["SISMEMBER", ["SISMEMBER", "nl:t:s", "m"]],
  ["SMEMBERS", ["SMEMBERS", "nl:t:s2"]],
  ["ZSCORE", ["ZSCORE", "nl:t:z", "m"]],
  ["ZREVRANGE", ["ZREVRANGE", "nl:t:z2", 0, -1]],
  ["LRANGE", ["LRANGE", "nl:t:l", 0, -1]],
  ["HSCAN", ["HSCAN", "nl:t:h3", "0"]],
];
for (const [what, command] of reads) {
  redis.run(command);
  const key = String(command[1]);
  is(`${what}: then DEL answers 0`, redis.run(["DEL", key]), 0);
  redis.run(command);
  is(`${what}: then EXISTS answers 0`, redis.run(["EXISTS", key]), 0);
  is(`${what}: then TYPE answers none`, redis.run(["TYPE", key]), "none");
}
is("and SCAN lists none of them", (redis.run(["SCAN", "0", "MATCH", "nl:t:*"]) as [string, string[]])[1], []);

part("A collection whose last member goes is gone");
redis.run(["HSET", "nl:t:h", "f", "1"]);
redis.run(["HDEL", "nl:t:h", "f"]);
is("HDEL of the last field: EXISTS 0", redis.run(["EXISTS", "nl:t:h"]), 0);
redis.run(["SADD", "nl:t:s", "m"]);
redis.run(["SREM", "nl:t:s", "m"]);
is("SREM of the last member: DEL answers 0", redis.run(["DEL", "nl:t:s"]), 0);
redis.run(["ZADD", "nl:t:z", 1, "m"]);
redis.run(["ZREM", "nl:t:z", "m"]);
is("ZREM of the last member: TYPE none", redis.run(["TYPE", "nl:t:z"]), "none");
redis.run(["RPUSH", "nl:t:l", "a"]);
redis.run(["LREM", "nl:t:l", 0, "a"]);
is("LREM of the last item: EXISTS 0", redis.run(["EXISTS", "nl:t:l"]), 0);

part("A collection with members is untouched");
redis.run(["HSET", "nl:t:h", "f", "1", "g", "2"]);
redis.run(["HDEL", "nl:t:h", "f"]);
is("a hash with a field left is still there", [redis.run(["EXISTS", "nl:t:h"]), redis.run(["HGET", "nl:t:h", "g"])], [1, "2"]);
is("and DEL counts it", redis.run(["DEL", "nl:t:h"]), 1);
redis.run(["SADD", "nl:t:s", "a"]);
is("a set read is the same set", [redis.run(["SISMEMBER", "nl:t:s", "a"]), redis.run(["TYPE", "nl:t:s"])], [1, "set"]);

done();
