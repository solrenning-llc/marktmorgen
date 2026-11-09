/**
 * The in-memory Redis (lib/redis-memory.ts) ends a key at an absolute time as Redis does: SET … EXAT and EXPIREAT
 * take unix seconds, a later read finds the key gone once that time has passed, and EXPIREAT answers 0 for a key that
 * is not there. lib/paypal-sales.ts keeps an order's record until thirty days from its opening with both (#3411).
 */
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";

redis.clear();
const K = "nl:test:exat";
const now = () => Math.floor(Date.now() / 1000);

part("SET … EXAT: the key ends at that second");
const at = now() + 100;
is("set", redis.run(["SET", K, "v", "EXAT", String(at)]), "OK");
is("its life is what is left until then", (redis.run(["TTL", K]) as number) > 90 && (redis.run(["TTL", K]) as number) <= 100, true);
is("it ends at that time, in ms", redis.run(["PEXPIRETIME", K]), at * 1000);
redis.advance(101_000);
is("read after it, it is gone", redis.run(["GET", K]), null);

part("EXPIREAT: 1 for a key there, 0 for one that is not; the key ends at that second");
redis.clear();
redis.run(["SET", K, "v", "EX", 5]);
const later = now() + 1_000;
is("a key there", redis.run(["EXPIREAT", K, String(later)]), 1);
is("ends at that time, in ms", redis.run(["PEXPIRETIME", K]), later * 1000);
is("a key not there", redis.run(["EXPIREAT", "nl:test:none", String(later)]), 0);
redis.advance(1_001_000);
is("read after it, it is gone", redis.run(["GET", K]), null);

part("Control: SET … EX and a plain SET as before");
redis.clear();
redis.run(["SET", K, "v", "EX", 50]);
is("EX still counts from now", (redis.run(["TTL", K]) as number) > 40 && (redis.run(["TTL", K]) as number) <= 50, true);
redis.run(["SET", K, "w"]);
is("a plain SET keeps no life", redis.run(["TTL", K]), -1);

done();
