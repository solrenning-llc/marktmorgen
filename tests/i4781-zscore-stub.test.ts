/**
 * The in-memory Redis's ZSCORE (lib/redis-memory.ts), as Redis answers it (#4781; 6QpVd's review): a missing key is
 * none and stays missing, a sorted set answers its member's score, and a key of another kind answers WRONGTYPE,
 * never read as an empty sorted set and never overwritten with one.
 */
import { MemoryRedis } from "@/lib/redis-memory";
import { done, is, part } from "./check";

const redis = new MemoryRedis();
const outcome = (command: (string | number)[]) => {
  try {
    return JSON.stringify(redis.run(command));
  } catch (error) {
    return String((error as Error).message).split(" ")[0];
  }
};

part("ZSCORE as Redis answers it");
is("a missing key: none", outcome(["ZSCORE", "missing", "m"]), "null");
is("and the read makes no key", redis.keys().includes("missing"), false);
redis.run(["ZADD", "set", 7, "m"]);
is("a sorted set: the member's score", outcome(["ZSCORE", "set", "m"]), JSON.stringify("7"));
is("a member not in it: none", outcome(["ZSCORE", "set", "other"]), "null");
redis.run(["SET", "text", "value"]);
is("a string: WRONGTYPE", outcome(["ZSCORE", "text", "m"]), "WRONGTYPE");
is("and the string is kept", redis.run(["GET", "text"]), "value");
redis.run(["RPUSH", "list", "a"]);
is("a list: WRONGTYPE", outcome(["ZSCORE", "list", "a"]), "WRONGTYPE");
is("and the list is kept", redis.run(["LRANGE", "list", 0, -1]), ["a"]);
redis.run(["HSET", "hash", "f", "v"]);
is("a hash: WRONGTYPE", outcome(["ZSCORE", "hash", "f"]), "WRONGTYPE");
done();
