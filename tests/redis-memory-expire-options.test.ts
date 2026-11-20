/**
 * The tests' Redis (lib/redis-memory.ts) answers EXPIRE, PEXPIRE and EXPIREAT with NX, XX, GT and LT as Redis 7 does
 * (redis.io/docs/latest/commands/expire). It ignored every option and always moved the expiry: a fixed window kept
 * with INCR then EXPIRE NX (lib/podcast-access.ts, lib/store-readings.ts, lib/calendar-sync.ts, lib/plan-withdrawal.ts)
 * slid forward on every use in the tests and never in production, so a test of "the window resets after its time"
 * checked something production does not do. Each expected answer below is redis-server 7.0's own, checked against a
 * real server (Claude 7, Redis race hunt: a run of the whole suite against memory and a real redis-server side by side).
 */
import { MemoryRedis } from "@/lib/redis-memory";
import { done, is } from "./check";

const at = Date.parse("2026-11-12T12:00:00Z");
const redis = new MemoryRedis();
redis.now = () => at;
const run = (...command: (string | number)[]) => redis.run(command);
const ttl = (key: string) => run("TTL", key);
const throws = (command: (string | number)[]) => {
  try {
    redis.run(command);
    return false;
  } catch {
    return true;
  }
};

run("SET", "k", "1");
is("NX on a key with no expiry sets it", [run("EXPIRE", "k", 100, "NX"), ttl("k")], [1, 100]);
is("NX on a key with an expiry answers 0 and keeps it", [run("EXPIRE", "k", 500, "NX"), ttl("k")], [0, 100]);
is("XX on a key with an expiry moves it", [run("EXPIRE", "k", 300, "XX"), ttl("k")], [1, 300]);
is("GT to an earlier time answers 0 and keeps it", [run("EXPIRE", "k", 200, "GT"), ttl("k")], [0, 300]);
is("GT to a later time moves it", [run("EXPIRE", "k", 400, "GT"), ttl("k")], [1, 400]);
is("LT to a later time answers 0 and keeps it", [run("EXPIRE", "k", 900, "LT"), ttl("k")], [0, 400]);
is("LT to an earlier time moves it", [run("EXPIRE", "k", 50, "LT"), ttl("k")], [1, 50]);
is("plain EXPIRE always moves it", [run("EXPIRE", "k", 70), ttl("k")], [1, 70]);

run("SET", "n", "1");
is("XX on a key with no expiry answers 0", [run("EXPIRE", "n", 100, "XX"), ttl("n")], [0, -1]);
is("GT on a key with no expiry answers 0 (none counts as never)", [run("EXPIRE", "n", 100, "GT"), ttl("n")], [0, -1]);
is("LT on a key with no expiry sets it", [run("EXPIRE", "n", 100, "LT"), ttl("n")], [1, 100]);

is("a missing key answers 0 with or without an option", [run("EXPIRE", "gone", 10), run("EXPIRE", "gone", 10, "NX")], [0, 0]);
run("SET", "p", "1");
is("PEXPIRE NX sets then keeps", [run("PEXPIRE", "p", 5000, "NX"), run("PEXPIRE", "p", 9000, "NX"), run("PTTL", "p")], [1, 0, 5000]);
run("SET", "a", "1");
is("EXPIREAT NX sets then keeps", [run("EXPIREAT", "a", at / 1000 + 60, "NX"), run("EXPIREAT", "a", at / 1000 + 600, "NX"), ttl("a")], [1, 0, 60]);
run("SET", "z", "1");
is("a time already past deletes the key and answers 1", [run("EXPIRE", "z", 0), run("EXISTS", "z")], [1, 0]);

is("NX with GT is an error, as on Redis", throws(["EXPIRE", "k", 10, "NX", "GT"]), true);
is("GT with LT is an error, as on Redis", throws(["EXPIRE", "k", 10, "GT", "LT"]), true);
is("an unknown option is an error, as on Redis", throws(["EXPIRE", "k", 10, "SOON"]), true);

// The window INCR then EXPIRE NX keeps: fixed from its first use, as on Redis.
run("INCR", "w");
run("EXPIRE", "w", 3600, "NX");
redis.advance(1800_000);
run("INCR", "w");
run("EXPIRE", "w", 3600, "NX");
is("a second use half way through does not move the window", ttl("w"), 1800);
done();
