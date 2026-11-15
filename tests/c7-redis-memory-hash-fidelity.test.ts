/**
 * The in-memory Redis (lib/redis-memory.ts), its hashes, sets, lists and counters against redis-server 7 (C7,
 * 15 November 2026): a read of a missing key made it (an empty hash, set or list), and a command of one kind on a key
 * of another replaced the value with an empty one of its own kind, where Redis answers WRONGTYPE and keeps it.
 */
import { MemoryRedis } from "@/lib/redis-memory";
import { done, is, part } from "./check";

const said = (r: MemoryRedis, command: string[]): unknown => {
  try {
    return r.run(command);
  } catch (error) {
    return String(error instanceof Error ? error.message : error).split(" ")[0];
  }
};

async function main(): Promise<void> {
  part("A command of another kind on a sorted set: WRONGTYPE, and the sorted set kept");
  for (const command of [
    ["HGET", "z", "f"], ["HSET", "z", "f", "v"], ["HGETALL", "z"], ["HINCRBY", "z", "f", "1"],
    ["SADD", "z", "m"], ["SMEMBERS", "z"], ["SISMEMBER", "z", "m"],
    ["INCR", "z"], ["INCRBY", "z", "2"],
    ["LPUSH", "z", "a"], ["RPUSH", "z", "a"], ["LRANGE", "z", "0", "-1"],
  ]) {
    const r = new MemoryRedis();
    r.run(["ZADD", "z", "1", "m"]);
    is(`${command[0]}: WRONGTYPE`, said(r, command), "WRONGTYPE");
    is(`${command[0]}: the sorted set is kept`, said(r, ["ZSCORE", "z", "m"]), "1");
  }

  part("A read of a missing hash, set or list makes no key");
  for (const command of [
    ["HGET", "nk", "f"], ["HGETALL", "nk"], ["HLEN", "nk"], ["HEXISTS", "nk", "f"], ["HKEYS", "nk"],
    ["SMEMBERS", "nk"], ["SISMEMBER", "nk", "m"], ["SCARD", "nk"],
    ["LRANGE", "nk", "0", "-1"], ["LLEN", "nk"],
  ]) {
    const r = new MemoryRedis();
    said(r, command);
    is(`${command[0]}: no key`, r.run(["EXISTS", "nk"]), 0);
  }

  part("Control: a hash written and read as before");
  {
    const r = new MemoryRedis();
    r.run(["HSET", "h", "a", "1"]);
    is("HGET", r.run(["HGET", "h", "a"]), "1");
    is("HLEN", r.run(["HLEN", "h"]), 1);
    is("INCR on a counter", [r.run(["INCR", "c"]), r.run(["INCR", "c"])], [1, 2]);
  }
  done();
}
main().catch((error) => { console.error(error); process.exit(1); });
