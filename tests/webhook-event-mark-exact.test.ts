/**
 * A webhook event's once-mark is read exactly (CX-123 rule 24, lib/webhooks.ts emitEvent; lib/claim-mark.ts): "OK"
 * is the first time the event is noticed, nil is "already sent". Any other answer, or none, is read back: the mark
 * holding this run's own value is ours, another value is somebody else's (already sent), anything else is unknown,
 * so nothing is written and the event is not taken as sent: the mark this run may have written is let go (only while
 * it still holds this run's value) and the error is thrown, so the event is noticed again.
 *
 * Before: any reply but nil was "first time", so a malformed reply wrote the event's deliveries a second time.
 * Healthy marks, an event really sent (nil), and a mark that landed but was answered oddly stay as they should.
 */
import { addEndpoint, emitEvent, eventIdFor, setSendHooksForTests } from "@/lib/webhooks";
import { claimHandle, ensureStatsId, setSubscription, storeForEmail } from "@/lib/store";
import { paidPeriod } from "./billing-period-fixture";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";

/** How the event mark's SET NX is answered ("real", "drop", "throw" or a value in its place); `readBack` likewise for a GET of it. */
let markReply: unknown = "real";
let readBack: unknown = "real";
let target = "";
const pipeline = redis.pipeline.bind(redis);
const shaped = (real: unknown[], at: number, how: unknown): unknown[] => {
  if (how === "throw") throw new Error("synthetic: connection reset");
  if (how === "drop") return real.filter((_, i) => i !== at);
  return real.map((r, i) => (i === at ? how : r));
};
redis.pipeline = (async (commands: (string | number)[][]) => {
  const real = await pipeline(commands);
  const nx = commands.findIndex((c) => c[0] === "SET" && c[1] === target && c.includes("NX"));
  if (nx >= 0 && markReply !== "real") return shaped(real, nx, markReply);
  const get = commands.length === 1 ? commands.findIndex((c) => c[0] === "GET" && c[1] === target) : -1;
  if (get >= 0 && readBack !== "real") return shaped(real, get, readBack);
  return real;
}) as typeof redis.pipeline;

const reset = () => {
  markReply = "real";
  readBack = "real";
  target = "";
};
async function outcome<T>(work: () => Promise<T>): Promise<T | "threw"> {
  try {
    return await work();
  } catch {
    return "threw";
  }
}
const markKey = (statsId: string, seed: string) => `nl:hooks:evt:${eventIdFor(statsId, "sale.completed", seed)}`;
const ODD: [string, unknown][] = [["no reply", "drop"], ["a number", 1], ["a list", ["OK"]], ["an empty string", ""], ["the request failed", "throw"]];

async function main(): Promise<void> {
  redis.clear();
  // Every try goes to a private address and is refused before any socket opens: nothing leaves this process.
  setSendHooksForTests({ fetch: { resolve: async () => [{ address: "10.0.0.1", family: 4 }] } });
  await claimHandle("hook-mark@example.com", "hook-mark", "Hook Mark", "");
  await ensureStatsId("hook-mark@example.com");
  await setSubscription("hook-mark@example.com", { customerId: "cus_HookMark0001", subscriptionId: "sub_HookMark0001", active: true, period: paidPeriod() });
  const store = (await storeForEmail("hook-mark@example.com"))!;
  const statsId = store.statsId as string;
  const added = await addEndpoint(store, "https://hooks.example.com/sales", ["sale.completed"]);
  is("setup: the endpoint", added.ok, true);

  part("healthy: the first time is written, the second is not");
  is("first time: one delivery", await emitEvent(store, "sale.completed", "cs_mark_healthy", {}), 1);
  is("noticed again (nil): none", await emitEvent(store, "sale.completed", "cs_mark_healthy", {}), 0);

  part("an event already sent, answered oddly, is never written again");
  for (const [label, odd] of ODD) {
    target = markKey(statsId, "cs_mark_healthy");
    markReply = odd;
    const got = await outcome(() => emitEvent(store, "sale.completed", "cs_mark_healthy", {}));
    reset();
    is(`${label}: no delivery written`, got, 0);
  }

  part("a mark that landed but was answered oddly is read back as ours");
  for (const [label, odd] of ODD) {
    const seed = `cs_mark_landed_${ODD.findIndex(([l]) => l === label)}`;
    target = markKey(statsId, seed);
    markReply = odd;
    const got = await outcome(() => emitEvent(store, "sale.completed", seed, {}));
    reset();
    is(`${label}: one delivery`, got, 1);
  }

  part("a mark that cannot be read back is unknown: nothing written, the mark let go, so it is noticed again");
  for (const [label, odd] of ODD) {
    const seed = `cs_mark_unread_${ODD.findIndex(([l]) => l === label)}`;
    target = markKey(statsId, seed);
    markReply = odd;
    readBack = "throw";
    const got = await outcome(() => emitEvent(store, "sale.completed", seed, {}));
    reset();
    is(`${label}: it throws`, got, "threw");
    is(`${label}: the mark is not kept`, (await pipeline([["GET", markKey(statsId, seed)]]))[0], null);
    is(`${label}: noticed again, it is written once`, await emitEvent(store, "sale.completed", seed, {}), 1);
  }

  part("an unknown answer over another run's mark leaves that mark alone");
  target = markKey(statsId, "cs_mark_healthy");
  const before = (await pipeline([["GET", target]]))[0];
  markReply = "throw";
  readBack = 7;
  is("it throws", await outcome(() => emitEvent(store, "sale.completed", "cs_mark_healthy", {})), "threw");
  reset();
  is("the other run's mark is kept", (await pipeline([["GET", markKey(statsId, "cs_mark_healthy")]]))[0], before);
  done();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
