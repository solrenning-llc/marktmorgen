/**
 * Issue #4274, the rest of it (C7, 15 November 2026): DEL already takes a key's expiry with it, but a hash, set or
 * list emptied by HDEL, SPOP, LREM or LTRIM stayed a key in the in-memory Redis, and one emptied by SREM or LPOP left
 * its expiry behind; a key made again under the same name then took the old expiry. On redis-server 7 every one of
 * them deletes the key and its expiry (EXISTS 0, then TTL -1 for the key made again), and LTRIM of a missing key
 * makes nothing.
 */
import { MemoryRedis } from "@/lib/redis-memory";
import { done, is, part } from "./check";

async function main(): Promise<void> {
  part("A collection emptied by its last member's removal is no longer a key, and leaves no expiry");
  const cases: [string, (string | number)[], (string | number)[]][] = [
    ["HDEL", ["HSET", "k", "f", "v"], ["HDEL", "k", "f"]],
    ["SREM", ["SADD", "k", "m"], ["SREM", "k", "m"]],
    ["SPOP", ["SADD", "k", "m"], ["SPOP", "k"]],
    ["LPOP", ["RPUSH", "k", "m"], ["LPOP", "k"]],
    ["LREM", ["RPUSH", "k", "m"], ["LREM", "k", 0, "m"]],
    ["LTRIM", ["RPUSH", "k", "m"], ["LTRIM", "k", 1, 0]],
    ["ZREM", ["ZADD", "k", 1, "m"], ["ZREM", "k", "m"]],
  ];
  for (const [name, make, empty] of cases) {
    const r = new MemoryRedis();
    r.run(make.map(String));
    r.run(["EXPIRE", "k", "10"]);
    r.run(empty.map(String));
    is(`${name}: the emptied key is gone`, r.run(["EXISTS", "k"]), 0);
    r.run(["HSET", "k", "new", "1"]);
    is(`${name}: the key made again has no expiry`, r.run(["TTL", "k"]), -1);
    r.advance(20_000);
    is(`${name}: and outlives the old one`, r.run(["HGET", "k", "new"]), "1");
  }

  part("LTRIM of a missing key makes nothing");
  {
    const r = new MemoryRedis();
    is("answers OK", r.run(["LTRIM", "nk", "0", "1"]), "OK");
    is("no key", r.run(["EXISTS", "nk"]), 0);
  }

  part("Control: a collection that keeps a member keeps its expiry");
  {
    const r = new MemoryRedis();
    r.run(["HSET", "k", "a", "1", "b", "2"]);
    r.run(["EXPIRE", "k", "10"]);
    r.run(["HDEL", "k", "a"]);
    is("the key stays, with its expiry", [r.run(["EXISTS", "k"]), r.run(["TTL", "k"])], [1, 10]);
  }
  done();
}
main().catch((error) => { console.error(error); process.exit(1); });
