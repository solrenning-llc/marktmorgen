import { MemoryRedis } from "@/lib/redis-memory";
import { done, is, part } from "./check";

const redis = new MemoryRedis();
part("GET preserves missing and every string");
is("a missing key is null", redis.run(["GET", "missing"]), null);
for (const value of ["", "0", "plain text"]) {
  redis.run(["SET", "value", value]);
  is("the exact stored string survives", redis.run(["GET", "value"]), value);
}
part("GET refuses other types without replacing them");
for (const command of [
  ["HSET", "hash", "field", "value"],
  ["RPUSH", "list", "value"],
  ["SADD", "set", "value"],
  ["ZADD", "sorted", "1", "value"],
]) {
  redis.run(command);
  let message = "";
  try { redis.run(["GET", command[1]]); } catch (error) {
    message = error instanceof Error ? error.message : "";
  }
  is("an existing non-string is WRONGTYPE", message, "WRONGTYPE");
}
is("the hash survives the failed GET", redis.run(["HGET", "hash", "field"]), "value");
is("the list survives the failed GET", redis.run(["LRANGE", "list", "0", "-1"]), ["value"]);
is("the set survives the failed GET", redis.run(["SISMEMBER", "set", "value"]), 1);
is("the sorted set survives the failed GET", redis.run(["ZSCORE", "sorted", "value"]), "1");
part("Expiry and SET replace a wrong type as Redis does");
redis.run(["EXPIRE", "hash", 1]);
redis.advance(1_001);
is("an expired wrong type is absent", redis.run(["GET", "hash"]), null);
redis.run(["SET", "list", "new string"]);
is("SET replaces the previous type", redis.run(["GET", "list"]), "new string");
done();
