/**
 * Every script the tests' stand-in Redis runs (tests/redis-take-scripts.ts) must also run in lib/redis-memory.ts
 * itself, the MemoryRedis that `next dev`, the demo store and the Mobile render job use with no test stub around it.
 * Claude 1 DKvY found 14 of them missing there (22/11/2026): the demo's seeding called one of them, MemoryRedis threw
 * "unsupported EVAL", and #4969's Mobile render failed. Here each script runs, on the same keys and arguments, once in
 * a plain MemoryRedis and once in the stand-in, and the two must give the same answer and leave the same keys.
 * Every script of the stand-in has a case, so a new one cannot be added without it. Synthetic keys only.
 */
import { MemoryRedis } from "@/lib/redis-memory";
import { TAKE_SCRIPT_NAMES, withTakeScripts } from "./redis-take-scripts";
import { done, is, part } from "./check";

type Command = (string | number)[];
type Case = { what: string; setup: Command[]; keys: string[]; argv: (string | number)[] };

const record = (statsId: string) => JSON.stringify({ statsId, handle: "shop" });
const CASES: Record<string, Case[]> = {
  "about-write-live:v2": [
    { what: "a live store, written", setup: [["SET", "k:id", "ref1"], ["SET", "k:about", "old"]], keys: ["k:id", "k:erasing", "k:about"], argv: ["f1", "0", "", "new", "ref1"] },
    { what: "a live store, compared and written", setup: [["SET", "k:id", "ref1"], ["SET", "k:about", "old"]], keys: ["k:id", "k:erasing", "k:about"], argv: ["f1", "1", "old", "new", "ref1"] },
    { what: "a description changed meanwhile", setup: [["SET", "k:id", "ref1"], ["SET", "k:about", "other"]], keys: ["k:id", "k:erasing", "k:about"], argv: ["f1", "1", "old", "new", "ref1"] },
    { what: "an empty text deletes it", setup: [["SET", "k:id", "ref1"], ["SET", "k:about", "old"]], keys: ["k:id", "k:erasing", "k:about"], argv: ["f1", "0", "", "", "ref1"] },
    { what: "an id key holding another ref", setup: [["SET", "k:id", "ref2"], ["SET", "k:about", "old"]], keys: ["k:id", "k:erasing", "k:about"], argv: ["f1", "0", "", "new", "ref1"] },
    { what: "an erasing store", setup: [["SET", "k:id", "ref1"], ["HSET", "k:erasing", "f1", "1"]], keys: ["k:id", "k:erasing", "k:about"], argv: ["f1", "0", "", "new", "ref1"] },
  ],
  "card-open-live:v1": [
    { what: "a live store", setup: [["SET", "k:id", "s1"]], keys: ["k:id", "k:erasing", "k:open"], argv: ["f1", "sess", 600] },
    { what: "no store", setup: [], keys: ["k:id", "k:erasing", "k:open"], argv: ["f1", "sess", 600] },
    { what: "an erasing store", setup: [["SET", "k:id", "s1"], ["HSET", "k:erasing", "f1", "1"]], keys: ["k:id", "k:erasing", "k:open"], argv: ["f1", "sess", 600] },
  ],
  "hash-take-all:v1": [
    { what: "a hash", setup: [["HSET", "k:h", "a", "1", "b", "2"]], keys: ["k:h"], argv: [] },
    { what: "no hash", setup: [], keys: ["k:h"], argv: [] },
  ],
  "hash-take-field:v1": [
    { what: "a field there", setup: [["HSET", "k:h", "a", "1", "b", "2"]], keys: ["k:h"], argv: ["a"] },
    { what: "a field not there", setup: [["HSET", "k:h", "b", "2"]], keys: ["k:h"], argv: ["a"] },
  ],
  "hash-swap-if:v1": [
    { what: "as read", setup: [["HSET", "k:h", "a", "old"]], keys: ["k:h"], argv: ["a", "old", "new"] },
    { what: "changed meanwhile", setup: [["HSET", "k:h", "a", "other"]], keys: ["k:h"], argv: ["a", "old", "new"] },
  ],
  "hash-del-if:v1": [
    { what: "as read", setup: [["HSET", "k:h", "a", "old", "b", "2"]], keys: ["k:h"], argv: ["a", "old"] },
    { what: "changed meanwhile", setup: [["HSET", "k:h", "a", "other"]], keys: ["k:h"], argv: ["a", "old"] },
  ],
  "member-cas:v1": [
    { what: "as read, listed", setup: [["HSET", "k:m", "u1", "old"]], keys: ["k:m", "k:dir"], argv: ["u1", "old", "new", "1", 1700000000] },
    { what: "as read, taken off the directory", setup: [["HSET", "k:m", "u1", "old"], ["ZADD", "k:dir", 1, "u1"]], keys: ["k:m", "k:dir"], argv: ["u1", "old", "new", "0", 1700000000] },
    { what: "changed meanwhile", setup: [["HSET", "k:m", "u1", "other"]], keys: ["k:m", "k:dir"], argv: ["u1", "old", "new", "1", 1700000000] },
  ],
  "recent-feed-live:v2": [
    { what: "a live store", setup: [["SET", "k:live", "ref1"]], keys: ["k:live", "k:erasing", "k:feed"], argv: ["f1", "[]", 300, "ref1"] },
    { what: "an id key holding another ref", setup: [["SET", "k:live", "ref2"]], keys: ["k:live", "k:erasing", "k:feed"], argv: ["f1", "[]", 300, "ref1"] },
    { what: "an erasing store", setup: [["SET", "k:live", "ref1"], ["HSET", "k:erasing", "f1", "1"]], keys: ["k:live", "k:erasing", "k:feed"], argv: ["f1", "[]", 300, "ref1"] },
    { what: "no store", setup: [], keys: ["k:live", "k:erasing", "k:feed"], argv: ["f1", "[]", 300, "ref1"] },
  ],
  "recent-sale-live:v2": [
    { what: "a live store", setup: [["SET", "k:id", "ref1"], ["SET", "k:feed", "cached"]], keys: ["k:id", "k:erasing", "k:list", "k:feed"], argv: ["f1", "{}", 4, 600, "ref1"] },
    { what: "an id key holding another ref", setup: [["SET", "k:id", "ref2"], ["SET", "k:feed", "cached"]], keys: ["k:id", "k:erasing", "k:list", "k:feed"], argv: ["f1", "{}", 4, 600, "ref1"] },
    { what: "no store", setup: [], keys: ["k:id", "k:erasing", "k:list", "k:feed"], argv: ["f1", "{}", 4, 600, "ref1"] },
    { what: "an erasing store", setup: [["SET", "k:id", "ref1"], ["HSET", "k:erasing", "f1", "1"]], keys: ["k:id", "k:erasing", "k:list", "k:feed"], argv: ["f1", "{}", 4, 600, "ref1"] },
  ],
  "recovery-report-live:v1": [
    { what: "a live store", setup: [["SET", "k:id", "s1"]], keys: ["k:id", "k:erasing", "k:report"], argv: ["f1", "{}", 300] },
    { what: "an erasing store", setup: [["SET", "k:id", "s1"], ["HSET", "k:erasing", "f1", "1"]], keys: ["k:id", "k:erasing", "k:report"], argv: ["f1", "{}", 300] },
    { what: "no store", setup: [], keys: ["k:id", "k:erasing", "k:report"], argv: ["f1", "{}", 300] },
  ],
  "sales-goal-live:v1": [
    { what: "a live store, a goal", setup: [["SET", "k:live", "x"]], keys: ["k:live", "k:erasing", "k:goal"], argv: ["f1", "500"] },
    { what: "a live store, the goal cleared", setup: [["SET", "k:live", "x"], ["SET", "k:goal", "500"]], keys: ["k:live", "k:erasing", "k:goal"], argv: ["f1", ""] },
    { what: "an erasing store", setup: [["SET", "k:live", "x"], ["HSET", "k:erasing", "f1", "1"]], keys: ["k:live", "k:erasing", "k:goal"], argv: ["f1", "500"] },
    { what: "no store", setup: [], keys: ["k:live", "k:erasing", "k:goal"], argv: ["f1", "500"] },
  ],
  "set-and-values-take:v1": [
    { what: "a set and two values, one there", setup: [["SADD", "k:s", "a", "b"], ["SET", "k:v1", "one"]], keys: ["k:s", "k:v1", "k:v2"], argv: [] },
    { what: "nothing there", setup: [], keys: ["k:s", "k:v1"], argv: [] },
  ],
  "set-take-count:v1": [
    { what: "a set", setup: [["SADD", "k:s", "a", "b", "c"]], keys: ["k:s"], argv: [] },
    { what: "no set", setup: [], keys: ["k:s"], argv: [] },
  ],
  "store-cache-live:v3": [
    { what: "an id key holding its ref", setup: [["SET", "k:live", "ref1"]], keys: ["k:live", "k:erasing", "k:cache"], argv: ["f1", "v", 60, "", "ref1"] },
    { what: "an id key holding another ref", setup: [["SET", "k:live", "ref2"]], keys: ["k:live", "k:erasing", "k:cache"], argv: ["f1", "v", 60, "", "ref1"] },
    { what: "an owner's record carrying its statsId", setup: [["SET", "k:live", record("st1")]], keys: ["k:live", "k:erasing", "k:cache"], argv: ["f1", "v", 60, "st1", ""] },
    { what: "an owner's record of another store", setup: [["SET", "k:live", record("st2")]], keys: ["k:live", "k:erasing", "k:cache"], argv: ["f1", "v", 60, "st1", ""] },
    { what: "an owner's record that does not parse", setup: [["SET", "k:live", "{not json"]], keys: ["k:live", "k:erasing", "k:cache"], argv: ["f1", "v", 60, "st1", ""] },
    { what: "no record", setup: [], keys: ["k:live", "k:erasing", "k:cache"], argv: ["f1", "v", 60, "st1", ""] },
    { what: "an erasing store", setup: [["SET", "k:live", "ref1"], ["HSET", "k:erasing", "f1", "1"]], keys: ["k:live", "k:erasing", "k:cache"], argv: ["f1", "v", 60, "", "ref1"] },
  ],
  "store-claim-live:v1": [
    { what: "an id key holding its ref", setup: [["SET", "k:live", "ref1"]], keys: ["k:live", "k:erasing", "k:mark"], argv: ["f1", "v", 60, "", "ref1"] },
    { what: "the mark already taken", setup: [["SET", "k:live", "ref1"], ["SET", "k:mark", "w"]], keys: ["k:live", "k:erasing", "k:mark"], argv: ["f1", "v", 60, "", "ref1"] },
    { what: "an owner's record carrying its statsId", setup: [["SET", "k:live", record("st1")]], keys: ["k:live", "k:erasing", "k:mark"], argv: ["f1", "v", 60, "st1", ""] },
    { what: "an owner's record that does not parse", setup: [["SET", "k:live", "{not json"]], keys: ["k:live", "k:erasing", "k:mark"], argv: ["f1", "v", 60, "st1", ""] },
    { what: "an owner's record of another store", setup: [["SET", "k:live", record("st2")]], keys: ["k:live", "k:erasing", "k:mark"], argv: ["f1", "v", 60, "st1", ""] },
    { what: "an erasing store", setup: [["SET", "k:live", "ref1"], ["HSET", "k:erasing", "f1", "1"]], keys: ["k:live", "k:erasing", "k:mark"], argv: ["f1", "v", 60, "", "ref1"] },
  ],
  "store-forget-complete:v1": [
    { what: "a store still in line", setup: [["HSET", "k:q", "st|s1", "{}"], ["HSET", "k:month", "done", "2"]], keys: ["k:q", "k:month"], argv: ["st|s1", 3600] },
    { what: "a store no longer in line", setup: [["HSET", "k:q", "st|s2", "{}"]], keys: ["k:q", "k:month"], argv: ["st|s1", 3600] },
  ],
  "weekly-team-live:v1": [
    { what: "a live store with an id: the list replaced", setup: [["SET", "k:id", "ref"], ["SADD", "k:to", "old@x.test"]], keys: ["k:id", "k:erasing", "k:to"], argv: ["f", "", "ref", "a@x.test", "b@x.test"] },
    { what: "a live store with an id: nobody chosen", setup: [["SET", "k:id", "ref"], ["SADD", "k:to", "old@x.test"]], keys: ["k:id", "k:erasing", "k:to"], argv: ["f", "", "ref"] },
    { what: "an erasing store", setup: [["SET", "k:id", "ref"], ["HSET", "k:erasing", "f", "1"], ["SADD", "k:to", "old@x.test"]], keys: ["k:id", "k:erasing", "k:to"], argv: ["f", "", "ref", "a@x.test"] },
    { what: "an id key that is no longer its own", setup: [["SET", "k:id", "other"]], keys: ["k:id", "k:erasing", "k:to"], argv: ["f", "", "ref", "a@x.test"] },
    { what: "a store from before ids, its own record", setup: [["SET", "k:rec", record("s1")]], keys: ["k:rec", "k:erasing", "k:to"], argv: ["f", "s1", "ref", "a@x.test"] },
    { what: "a store from before ids, another store's record", setup: [["SET", "k:rec", record("s2")]], keys: ["k:rec", "k:erasing", "k:to"], argv: ["f", "s1", "ref", "a@x.test"] },
    { what: "a store from before ids, a record that does not parse", setup: [["SET", "k:rec", "not json"]], keys: ["k:rec", "k:erasing", "k:to"], argv: ["f", "s1", "ref", "a@x.test"] },
  ],
  "zset-take-count:v1": [
    { what: "a sorted set", setup: [["ZADD", "k:z", 1, "a", 2, "b"]], keys: ["k:z"], argv: [] },
    { what: "no sorted set", setup: [], keys: ["k:z"], argv: [] },
  ],
};

/** Every key the store holds, with its kind, value and whether it ends. */
function dump(redis: MemoryRedis): unknown {
  return redis.keys().map((key) => {
    const type = String(redis.run(["TYPE", key]));
    const value =
      type === "string" ? redis.run(["GET", key])
      : type === "hash" ? redis.run(["HGETALL", key])
      : type === "set" ? [...(redis.run(["SMEMBERS", key]) as string[])].sort()
      : type === "zset" ? redis.run(["ZRANGE", key, 0, -1, "WITHSCORES"])
      : type === "list" ? redis.run(["LRANGE", key, 0, -1])
      : "?";
    return [key, type, value, Number(redis.run(["TTL", key])) > 0];
  });
}

function outcome(redis: MemoryRedis, c: Case, name: string): unknown {
  for (const command of c.setup) redis.run(command);
  let reply: unknown;
  try {
    reply = redis.run(["EVAL", `-- marktmorgen:${name}\nreturn 0`, c.keys.length, ...c.keys, ...c.argv]);
  } catch (error) {
    reply = `threw: ${(error as Error).message}`;
  }
  return { reply, keys: dump(redis) };
}

async function main(): Promise<void> {
  part("Every script of the stand-in has a case here");
  is("no script without a case", TAKE_SCRIPT_NAMES.filter((name) => !CASES[name]?.length), []);
  is("no case for a script the stand-in does not have", Object.keys(CASES).filter((name) => !TAKE_SCRIPT_NAMES.includes(name)), []);

  part("Each runs in lib/redis-memory.ts as in the stand-in: the same answer, the same keys left");
  const differs: string[] = [];
  for (const name of [...TAKE_SCRIPT_NAMES].sort()) {
    for (const c of CASES[name] ?? []) {
      const plain = outcome(new MemoryRedis(), c, name);
      const stand = outcome(withTakeScripts(new MemoryRedis()), c, name);
      if (JSON.stringify(plain) !== JSON.stringify(stand)) differs.push(`${name} (${c.what}): ${JSON.stringify(plain)} vs ${JSON.stringify(stand)}`);
      else console.log(`  ${name}, ${c.what}: ${JSON.stringify((stand as { reply: unknown }).reply)}`);
    }
  }
  const missing = [...new Set(differs.map((line) => line.split(" (")[0]))];
  is(`scripts that do not run the same in lib/redis-memory.ts (${missing.length})`, missing, []);
  for (const line of differs.slice(0, 40)) console.log(`  differs: ${line}`);
  done();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
