/**
 * The in-memory Redis double's sorted sets against what Redis itself answers (the answers below were read from
 * redis-server 7.0.15 on 9 November 2026, pre-review of claude5/call-refund-stores-cursor):
 *
 *   - members of one score are kept by their bytes, not by the locale's collation ("C3|Z" before "c1|b");
 *   - ZUNIONSTORE / ZINTERSTORE whose result has no member delete the destination (EXISTS 0), as does a ZREM that
 *     takes the last member out;
 *   - a weight of 0 on an infinite score gives 0, not NaN;
 *   - ZADD GT / LT move a member only up / down, and refuse NX with them;
 *   - ZRANGE by rank, with or without WITHSCORES.
 */
import { MemoryRedis } from "@/lib/redis-memory";
import { done, is, part } from "./check";

const redis = new MemoryRedis();
const run = (command: (string | number)[]): unknown => {
  try {
    return redis.run(command);
  } catch (error) {
    return `ERR ${(error as Error).message}`;
  }
};
const text = (value: unknown): unknown => (Array.isArray(value) ? value.map(text) : typeof value === "number" ? String(value) : value);

async function main(): Promise<void> {
  part("Members of one score");
  run(["ZADD", "S", 0, "c1|b", 0, "c2|a", 0, "C3|Z", 0, "c4|_"]);
  is("are kept by their bytes", text(run(["ZRANGEBYSCORE", "S", "-inf", "+inf", "WITHSCORES", "LIMIT", 0, 20])), ["C3|Z", "0", "c1|b", "0", "c2|a", "0", "c4|_", "0"]);

  part("A result with no member");
  run(["ZADD", "A", 1, "x"]);
  run(["ZADD", "B", 1, "y"]);
  run(["ZADD", "D", 5, "old"]);
  run(["ZINTERSTORE", "D", 2, "A", "B", "WEIGHTS", 1, 0]);
  is("ZINTERSTORE deletes the destination", text(run(["EXISTS", "D"])), "0");
  run(["ZADD", "D", 5, "old"]);
  run(["ZUNIONSTORE", "D", 2, "none1", "none2", "WEIGHTS", 1, 0, "AGGREGATE", "MAX"]);
  is("ZUNIONSTORE deletes the destination", text(run(["EXISTS", "D"])), "0");
  run(["ZREM", "S", "c1|b", "c2|a", "C3|Z", "c4|_"]);
  is("a ZREM that takes the last member out deletes the set", [text(run(["EXISTS", "S"])), text(run(["DEL", "S"]))], ["0", "0"]);

  part("Weights");
  run(["DEL", "A", "B", "D"]);
  run(["ZADD", "A", 1, "x", 2, "y"]);
  run(["ZADD", "B", "+inf", "x", 3, "z"]);
  run(["ZUNIONSTORE", "D", 2, "A", "B", "WEIGHTS", 1, 0, "AGGREGATE", "MAX"]);
  is("0 on an infinite score gives 0, and MAX keeps the greater", text(run(["ZRANGE", "D", 0, -1, "WITHSCORES"])), ["z", "0", "x", "1", "y", "2"]);
  run(["ZINTERSTORE", "D", 2, "A", "B", "WEIGHTS", 2, 0]);
  is("ZINTERSTORE sums the weighted scores", text(run(["ZRANGE", "D", 0, -1, "WITHSCORES"])), ["x", "0"]);
  is("a weight missing is an error", String(run(["ZUNIONSTORE", "D", 2, "A", "B", "WEIGHTS", 1])).startsWith("ERR"), true);

  part("ZADD GT and LT");
  run(["DEL", "S"]);
  run(["ZADD", "S", "GT", 100, "a"]);
  run(["ZADD", "S", "GT", 50, "a"]);
  is("GT never lowers", text(run(["ZSCORE", "S", "a"])), "100");
  is("GT CH counts a member moved up and one added", text(run(["ZADD", "S", "GT", "CH", 150, "a", 1, "b"])), "2");
  is("LT moves down only", [text(run(["ZADD", "S", "LT", "CH", 200, "a"])), text(run(["ZSCORE", "S", "a"]))], ["0", "150"]);
  is("NX with GT is refused", String(run(["ZADD", "S", "NX", "GT", 1, "a"])).startsWith("ERR"), true);
  is("GT with LT is refused", String(run(["ZADD", "S", "GT", "LT", 1, "a"])).startsWith("ERR"), true);
  is("ZRANGE by rank", text(run(["ZRANGE", "S", 0, -1])), ["b", "a"]);

  done();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
