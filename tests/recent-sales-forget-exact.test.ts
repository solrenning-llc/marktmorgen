/**
 * A deleted store's recent purchases (lib/recent-sales.ts, forgetRecentSales; #4752, found by Codex L): the list
 * nl:recent:<statsId> keeps up to 20 payment references with country, product and time and has no expiry, so its
 * deletion is confirmed only by the DEL's own reply, read exactly (CX-123 rule 24): one slot, a whole count from 0 to
 * 2. Any other reply (none, empty, a hole, text, negative, above 2, two slots) throws UnknownReplyError, so the
 * closing is not counted as done and can be run again. Synthetic data, in-memory Redis.
 */
import { forgetRecentSales } from "@/lib/recent-sales";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";

const real = redis.pipeline.bind(redis);
type Commands = (string | number)[][];
const statsId = "f".repeat(32);
let override: { reply: unknown } | null = null;
redis.pipeline = (async (commands: Commands) => (override && commands.some((c) => c[0] === "DEL") ? override.reply : real(commands))) as typeof redis.pipeline;

async function outcome(run: () => Promise<unknown>): Promise<string> {
  try {
    await run();
    return "resolved";
  } catch (error) {
    return (error as Error).name === "UnknownReplyError" ? "threw" : `other ${(error as Error).name}`;
  }
}

async function main(): Promise<void> {
  redis.clear();
  const list = `nl:recent:${statsId}`;
  const feed = `nl:recent:feed:${statsId}`;
  const sparse: unknown[] = [];
  sparse.length = 1;
  const odd: [string, unknown][] = [
    ["no reply", undefined], ["null", null], ["an empty reply", []], ["a hole", sparse], ["an undefined slot", [undefined]],
    ["text", ["OK"]], ["a numeric string", ["1"]], ["negative", [-1]], ["above 2", [3]], ["not whole", [1.5]], ["two slots", [1, 1]],
  ];
  for (const [name, reply] of odd) {
    part(`A deleted store's recent purchases, the DEL answered with ${name}`);
    override = null;
    await real([["RPUSH", list, JSON.stringify({ p: "prod", at: 1, c: "US", pi: "pi_private_purchase" })], ["SET", feed, "{}"]]);
    override = { reply };
    is("forgetRecentSales throws, never says it is done", await outcome(() => forgetRecentSales(statsId)), "threw");
    override = null;
    await real([["DEL", list, feed]]);
  }

  part("Controls: a DEL answered 0, 1 or 2 is done");
  override = null;
  await real([["SET", list, "z"], ["SET", feed, "w"]]);
  is("both there: resolved", await outcome(() => forgetRecentSales(statsId)), "resolved");
  is("both gone", await real([["EXISTS", list], ["EXISTS", feed]]), [0, 0]);
  await real([["SET", list, "z"]]);
  is("one there: resolved", await outcome(() => forgetRecentSales(statsId)), "resolved");
  is("nothing there: resolved", await outcome(() => forgetRecentSales(statsId)), "resolved");
  is("no store id: nothing asked", await outcome(() => forgetRecentSales(null)), "resolved");
  done();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
