/** Latent exported month reader: unknown own-data evidence is not a confirmed count. */
import { payoutUnknownMonth } from "@/lib/paypal-payouts";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";

async function main(): Promise<void> {
  part("An exact numeric month is confirmed; executable or inherited slots are unknown");
  const real = redis.pipeline;
  let visits = 0;
  try {
    redis.pipeline = async () => [["1", "2", "3"]];
    is("confirmed counts", await payoutUnknownMonth("2026-11"), { unknown: 1, settled: 2, manual: 3 });
    const inherited = new Array(1);
    Object.setPrototypeOf(inherited, { 0: ["1", "2", "3"] });
    redis.pipeline = async () => inherited;
    is("inherited outer reply is unknown", await payoutUnknownMonth("2026-11"), null);
    const executable = [["1", "2", "3"]];
    Object.defineProperty(executable, "0", { get() { visits++; return ["1", "2", "3"]; } });
    redis.pipeline = async () => executable;
    is("accessor outer reply is unknown", await payoutUnknownMonth("2026-11"), null);
    is("no executable property was observed", visits, 0);
  } finally { redis.pipeline = real; }
  done();
}
void main().catch(error => { console.error(error); process.exit(1); });
