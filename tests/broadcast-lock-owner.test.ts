/**
 * A campaign's lock belongs to the run that took it (CX-123 rule 24, review of #3306): it is written with a value only
 * that run holds (lib/claim-mark.ts claimValue), taken only on an exact "OK", and let go only while it still holds that
 * value (releaseMark). A pass slow enough for its lock to run out, whose lock another run then took, must never delete
 * the other run's lock on its way out: a third run would then take the campaign beside the second, and both would send
 * the same email. Synthetic data only, no provider is called.
 */
import { advanceBroadcast, cancelBroadcast } from "@/lib/broadcasts";
import type { Store } from "@/lib/store";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";

async function main() {
  const id = "333333333333333333333333";
  const key = "nl:mail:bc:" + id;
  const lock = key + ":lock";
  const queue = "nl:mail:queue";
  const store = { listId: "lock-owner-tests" } as Store;
  const record = { id, listId: store.listId, handle: "lock-owner", subject: "Scheduled", body: "Message", status: "scheduled", sent: 0, listed: false, sendAt: Math.floor(Date.now() / 1000) + 86400, createdAt: 100, total: 1, failures: 0, note: "", finishedAt: 0, productId: null, notProductId: null, who: "all", narrow: null, test: null, tagged: true };
  const original = redis.pipeline;
  let pauseRead: (() => Promise<void>) | null = null;
  let reads = 0;
  const lockValues: string[] = [];
  redis.pipeline = async commands => {
    for (const c of commands) if (c[0] === "SET" && c[1] === lock) lockValues.push(String(c[2]));
    if (commands.some(c => c[0] === "GET" && c[1] === key)) {
      reads += 1;
      const pause = pauseRead;
      pauseRead = null;
      if (pause) await pause();
    }
    return original.call(redis, commands);
  };
  const seed = async (value: Record<string, unknown> = record) => {
    pauseRead = null; reads = 0; lockValues.length = 0;
    await original.call(redis, [["DEL", lock], ["SET", key, JSON.stringify(value)], ["SADD", queue, id]]);
  };
  /** While the first run is between its lock and its read, its lock runs out and another run takes it with its own value. */
  const takenMeanwhile = () => {
    pauseRead = async () => { await original.call(redis, [["DEL", lock], ["SET", lock, "another-run", "EX", 90]]); };
  };
  const held = async () => (await original.call(redis, [["GET", lock]]))[0];
  try {
    part("Each run writes a value of its own");
    await seed();
    is("a cancellation takes and lets go of the lock", await cancelBroadcast(store, id), true);
    const first = [...lockValues];
    await seed();
    is("a second cancellation of a fresh campaign also runs", await cancelBroadcast(store, id), true);
    const both = [...first, ...lockValues];
    is("each run took the lock once", [first.length, lockValues.length], [1, 1]);
    is("the lock is never the shared value \"1\"", both.includes("1"), false);
    is("two runs never write the same lock value", new Set(both).size, 2);
    is("an own lock is let go at the end", await held(), null);

    part("A slow cancellation never deletes the lock another run took");
    await seed();
    takenMeanwhile();
    await cancelBroadcast(store, id);
    is("the other run's lock is still there after the slow run", await held(), "another-run");
    const before = reads;
    let loads = 0;
    is("a third run cannot take the campaign beside the second", await advanceBroadcast(id, async () => { loads += 1; return null; }, Date.now() + 1000), null);
    is("the third run reads nothing and loads no store", [reads - before, loads], [0, 0]);

    part("A slow send pass never deletes the lock another run took");
    await seed({ ...record, status: "cancelled", finishedAt: 200 });
    takenMeanwhile();
    await advanceBroadcast(id, async () => null, Date.now() + 1000);
    is("the other run's lock is still there after the slow pass", await held(), "another-run");
    await original.call(redis, [["SET", key, JSON.stringify(record)]]);
    is("a cancellation cannot enter beside the second run", await cancelBroadcast(store, id), false);
  } finally { redis.pipeline = original; }
  done();
}
void main();
