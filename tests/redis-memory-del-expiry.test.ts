/**
 * A key the tests' Redis (lib/redis-memory.ts) deletes loses its expiry with it, as on Redis: made again later, it has
 * none until one is set. Before, the expiry outlived the key, so a counter made again by INCR or DECRBY after a DEL
 * inherited the old expiry here and had none on Redis, and a test could never see a key left with no expiry
 * (Claude 7, Redis race hunt: found running the suite against memory and a real redis-server side by side, and by
 * lib/store-allowance.ts giveAllowance, whose counter made again below zero looked like it would run out).
 */
import { MemoryRedis } from "@/lib/redis-memory";
import { done, is } from "./check";

const redis = new MemoryRedis();
const run = (...command: (string | number)[]) => redis.run(command);

run("SET", "c", "5", "EX", 100);
run("DEL", "c");
run("DECRBY", "c", 3);
is("a counter made again after DEL has no expiry", [run("GET", "c"), run("TTL", "c")], ["-3", -1]);

run("SET", "g", "x", "EX", 100);
run("GETDEL", "g");
run("INCR", "g");
is("after GETDEL too", run("TTL", "g"), -1);

run("HSET", "h", "f", "v");
run("EXPIRE", "h", 100);
run("HDEL", "h", "f");
run("DEL", "h");
run("HSET", "h", "f", "v");
is("a hash made again after DEL has no expiry", run("TTL", "h"), -1);

run("SET", "k", "1", "EX", 100);
redis.clear();
run("SET", "k", "1");
is("after clear()", run("TTL", "k"), -1);

run("SET", "kept", "1", "EX", 100);
run("DEL", "other");
is("a DEL of another key leaves this one's expiry", run("TTL", "kept"), 100);
done();
