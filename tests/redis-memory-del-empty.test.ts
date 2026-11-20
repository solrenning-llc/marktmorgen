/**
 * The in-memory Redis (lib/redis-memory.ts) answers DEL as Redis does for a list, set, sorted set or hash that only a
 * read touched: Redis never keeps an empty one, so DEL finds no key there and answers 0. The stand-in makes an empty
 * one on a read (ZRANGEBYSCORE, SMEMBERS, HGETALL, LRANGE); counted, it let an erasure say it deleted a record that
 * never existed (lib/community-approval.ts forgetHeldPerson on a member with nothing held, found merging main into
 * #3095). Synthetic keys only.
 */
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";

redis.clear();

part("A key only read is not there to delete");
redis.run(["ZRANGEBYSCORE", "nl:test:del:z", "-inf", "+inf"]);
redis.run(["SMEMBERS", "nl:test:del:s"]);
redis.run(["HGETALL", "nl:test:del:h"]);
redis.run(["LRANGE", "nl:test:del:l", 0, -1]);
is("an empty sorted set", redis.run(["DEL", "nl:test:del:z"]), 0);
is("an empty set", redis.run(["DEL", "nl:test:del:s"]), 0);
is("an empty hash", redis.run(["DEL", "nl:test:del:h"]), 0);
is("an empty list", redis.run(["DEL", "nl:test:del:l"]), 0);
is("and nothing is left behind", redis.keys().filter((k) => k.startsWith("nl:test:del:")).length, 0);

part("A key with something in it still counts, one by one");
redis.run(["ZADD", "nl:test:del:z", 1, "a"]);
redis.run(["SADD", "nl:test:del:s", "a"]);
redis.run(["SET", "nl:test:del:str", ""]);
redis.run(["ZRANGEBYSCORE", "nl:test:del:empty", "-inf", "+inf"]);
is("two with members, one empty string, one only read", redis.run(["DEL", "nl:test:del:z", "nl:test:del:s", "nl:test:del:str", "nl:test:del:empty"]), 3);
is("a missing key", redis.run(["DEL", "nl:test:del:none"]), 0);

part("A set emptied by its last SREM is gone, as in Redis");
redis.run(["SADD", "nl:test:del:s2", "a"]);
redis.run(["SREM", "nl:test:del:s2", "a"]);
is("nothing to delete", redis.run(["DEL", "nl:test:del:s2"]), 0);

done();
