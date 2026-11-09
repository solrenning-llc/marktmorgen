/** Pre-review probe (synthetic): lock expiry, lost SET reply, failed release, concurrent passes, TTL vs maxDuration. */
import { readFileSync } from "node:fs";
import { advanceBroadcast, cancelBroadcast } from "@/lib/broadcasts";
import type { Store } from "@/lib/store";
import { store as redis, advance } from "./redis-stub";
import { done, is, part } from "./check";

async function main() {
  const id = "444444444444444444444444";
  const key = "nl:mail:bc:" + id;
  const lock = key + ":lock";
  const store = { listId: "probe" } as Store;
  const record = { id, listId: store.listId, handle: "probe", subject: "S", body: "B", status: "scheduled", sent: 0, listed: false, sendAt: Math.floor(Date.now() / 1000) + 86400, createdAt: 100, total: 1, failures: 0, note: "", finishedAt: 0, productId: null, notProductId: null, who: "all", narrow: null, test: null, tagged: true };
  const original = redis.pipeline;
  let loseSet = false, failEval = false, reads = 0;
  let pause: (() => Promise<void>) | null = null;
  redis.pipeline = async commands => {
    if (commands.some(c => c[0] === "GET" && c[1] === key)) { reads += 1; const p = pause; pause = null; if (p) await p(); }
    if (failEval && commands.some(c => c[0] === "EVAL")) throw new Error("script lost");
    const r = await original.call(redis, commands);
    if (loseSet && commands.some(c => c[0] === "SET" && c[1] === lock)) { loseSet = false; throw new Error("reply lost after SET applied"); }
    return r;
  };
  const seed = async () => { reads = 0; await original.call(redis, [["DEL", lock], ["SET", key, JSON.stringify(record)], ["SADD", "nl:mail:queue", id]]); };
  const ttl = async () => (await original.call(redis, [["TTL", lock]]))[0] as number;
  try {
    part("Lost reply after an applied SET");
    await seed(); loseSet = true;
    let threw = false;
    try { await advanceBroadcast(id, async () => null, Date.now() + 1000); } catch { threw = true; }
    is("the pass throws (nothing read)", [threw, reads], [true, 0]);
    const t = await ttl();
    is("the orphan lock has an expiry within 90 s", t > 0 && t <= 90, true);
    is("a second pass is refused while it lasts", await advanceBroadcast(id, async () => null, Date.now() + 1000), null);
    advance(91_000);
    is("after expiry the campaign is free again", await cancelBroadcast(store, id), true);

    part("Release script fails");
    await seed(); failEval = true;
    await cancelBroadcast(store, id);
    failEval = false;
    const t2 = await ttl();
    is("a lock not let go keeps an expiry (never stuck for good)", t2 > 0 && t2 <= 90, true);
    advance(91_000);
    is("and runs out", (await original.call(redis, [["GET", lock]]))[0], null);

    part("Two passes at once");
    await seed();
    let second: unknown = "unset";
    pause = async () => { second = await advanceBroadcast(id, async () => null, Date.now() + 1000); };
    await advanceBroadcast(id, async () => null, Date.now() + 1000);
    is("the second pass, while the first holds the lock, does nothing", second, null);

    part("Lock term vs run length");
    const route = (p: string) => Number(/maxDuration = (\d+)/.exec(readFileSync(p, "utf8"))?.[1]);
    const lockSeconds = Number(/\["SET", lockKey\(id\), token, "NX", "EX", (\d+)\]/.exec(readFileSync("lib/broadcasts.ts", "utf8"))?.[1]);
    is("lock 90 s outlasts both callers' maxDuration", [lockSeconds, route("app/api/cron/mail/route.ts") < lockSeconds, route("app/api/store/mail/route.ts") < lockSeconds], [90, true, true]);
  } finally { redis.pipeline = original; }
  done();
}
void main();
