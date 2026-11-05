/** Same latent exact-reader boundary: reflection on a Proxy is executable evidence. */
import { payoutUnknownMonth } from "@/lib/paypal-payouts";
import { store as redis } from "./redis-stub";
import { done, is } from "./check";
async function main(): Promise<void> {
  const original = redis.pipeline;
  let traps = 0;
  const wrap = <T extends unknown[]>(array: T): T => new Proxy(array, {
    get(target, property, receiver) { if (property !== "then") traps++; return Reflect.get(target, property, receiver); },
    getOwnPropertyDescriptor(target, property) { traps++; return Reflect.getOwnPropertyDescriptor(target, property); },
  });
  try {
    redis.pipeline = async () => [["1", "2", "3"]];
    is("inert own counts remain confirmed", await payoutUnknownMonth("2026-11"), { unknown: 1, settled: 2, manual: 3 });
    redis.pipeline = async () => wrap([["1", "2", "3"]]);
    is("outer proxy is unknown", await payoutUnknownMonth("2026-11"), null);
    redis.pipeline = async () => [wrap(["1", "2", "3"])];
    is("inner proxy is unknown", await payoutUnknownMonth("2026-11"), null);
    is("no executable reflection or property was observed", traps, 0);
  } finally { redis.pipeline = original; }
  done();
}
void main().catch(error => { console.error(error); process.exit(1); });
