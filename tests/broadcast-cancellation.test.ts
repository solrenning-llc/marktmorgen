import { advanceBroadcast, BroadcastCancellationUnconfirmed, cancelBroadcast } from "@/lib/broadcasts";
import type { Store } from "@/lib/store";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";
async function main() {
  const id = "111111111111111111111111";
  const key = "nl:mail:bc:" + id;
  const lock = key + ":lock";
  const queue = "nl:mail:queue";
  const store = { listId: "cancel-tests" } as Store;
  const record = { id, listId: store.listId, handle: "cancel-test", subject: "Scheduled", body: "Message", status: "scheduled", sent: 0, listed: false, sendAt: Math.floor(Date.now() / 1000) + 86400, createdAt: 100, total: 1, failures: 0, note: "", finishedAt: 0, productId: null, notProductId: null, who: "all", narrow: null, test: null, tagged: true };
  const original = redis.pipeline;
  const normal = Symbol("normal");
  let lockReply: unknown = normal, saveReply: unknown = normal, removeReply: unknown = normal;
  let apply = false, saves = 0, removals = 0, reads = 0;
  let pauseRead: (() => Promise<void>) | null = null;
  redis.pipeline = async commands => {
    const claim = commands.some(c => c[0] === "SET" && c[1] === lock);
    const save = commands.some(c => c[0] === "SET" && c[1] === key);
    const remove = commands.some(c => c[0] === "SREM" && c[1] === queue);
    if (commands.some(c => c[0] === "GET" && c[1] === key)) { reads += 1; if (pauseRead) await pauseRead(); }
    if (save) saves += 1;
    if (remove) removals += 1;
    const reply = claim ? lockReply : save ? saveReply : remove ? removeReply : normal;
    if (reply === normal) return original.call(redis, commands);
    if (apply) await original.call(redis, commands);
    if (reply instanceof Error) throw reply;
    return reply as unknown[];
  };
  const seed = async (value = record) => {
    lockReply = normal; saveReply = normal; removeReply = normal; apply = false; saves = 0; removals = 0; reads = 0; pauseRead = null;
    await original.call(redis, [["DEL", lock], ["SET", key, JSON.stringify(value)], ["SADD", queue, id]]);
  };
  const uncertain = async () => { try { await cancelBroadcast(store, id); return false; } catch (e) { return e instanceof BroadcastCancellationUnconfirmed; } };
  try {
    part("Confirmed cancellation and ownership");
    await seed();
    is("scheduled campaign cancels", await cancelBroadcast(store, id), true);
    is("canceled status is retained", JSON.parse(String((await original.call(redis, [["GET", key]]))[0])).status, "cancelled");
    is("queue membership removed and lock released", await original.call(redis, [["SISMEMBER", queue, id], ["GET", lock]]), [0, null]);
    is("already canceled is refused", await cancelBroadcast(store, id), false);
    for (const changed of [{ listId: "foreign" }, { id: "222222222222222222222222" }, { status: "sending" }, { listed: true }, { sent: 1 }]) {
      await seed({ ...record, ...changed });
      is("foreign, mismatched or started campaigns cannot cancel", await cancelBroadcast(store, id), false);
      is("refusal does not write or remove", [saves, removals], [0, 0]);
    }
    part("One holder excludes the sender and other cancellations");
    await seed();
    let release!: () => void, entered!: () => void;
    const blocked = new Promise<void>(resolve => { release = resolve; });
    const reached = new Promise<void>(resolve => { entered = resolve; });
    pauseRead = async () => { entered(); await blocked; };
    const cancelling = cancelBroadcast(store, id);
    await reached;
    let loads = 0;
    const advancing = await advanceBroadcast(id, async () => { loads += 1; return null; }, Date.now() + 1000);
    is("sender cannot advance during cancellation", advancing, null);
    is("sender never loads store while excluded", loads, 0);
    is("second cancellation cannot enter", await cancelBroadcast(store, id), false);
    release();
    is("first cancellation completes", await cancelling, true);
    await seed();
    await original.call(redis, [["SET", lock, "sender", "EX", 90]]);
    is("sender lock excludes cancellation", await cancelBroadcast(store, id), false);
    is("another holder's lock is retained", (await original.call(redis, [["GET", lock]]))[0], "sender");
    part("Unknown lock ownership cannot authorize changes");
    for (const reply of [[], [undefined], [true], [1], ["ok"], ["OK", null], new Error("lost lock reply")]) {
      await seed(); lockReply = reply;
      is("uncertain lock refuses cancellation", await uncertain(), true);
      is("no read or mutation without confirmed lock", [reads, saves, removals], [0, 0, 0]);
      let failed = false;
      try { await advanceBroadcast(id, async () => null, Date.now() + 1000); } catch { failed = true; }
      is("sender also rejects uncertain lock", failed, true);
      is("sender cannot read after uncertain lock", reads, 0);
    }
    await seed(); lockReply = new Error("applied claim response lost"); apply = true;
    is("lost lock response remains uncertain", await uncertain(), true);
    // Rule 23 (claude5/broadcast-lock-owner, review of #3306): was `"1"`, the fixed value every run wrote; the lock now
    // holds the run's own token (lib/claim-mark.ts claimValue), so what is checked is that the write that landed is
    // still there, a token and not the old shared value: uncertain ownership is still never let go.
    const kept = (await original.call(redis, [["GET", lock]]))[0];
    is("uncertain ownership is not unlocked", typeof kept === "string" && /^\d+\.\d{9}$/.test(kept), true);
    part("Cancellation requires both write acknowledgements");
    for (const reply of [[], [null], [true], ["ok"], ["OK", "OK"], new Error("lost save reply")]) {
      await seed(); saveReply = reply;
      is("record write uncertainty is reported", await uncertain(), true);
      is("record is attempted once without queue removal", [saves, removals], [1, 0]);
      is("owned lock is released after failure", (await original.call(redis, [["GET", lock]]))[0], null);
    }
    for (const reply of [[], [null], [true], ["1"], [-1], [2], [1, 0], new Error("lost removal reply")]) {
      await seed(); removeReply = reply;
      is("queue removal uncertainty is reported", await uncertain(), true);
      is("writes are not repeated", [saves, removals], [1, 1]);
      is("canceled state is not reverted", JSON.parse(String((await original.call(redis, [["GET", key]]))[0])).status, "cancelled");
    }
    await seed(); saveReply = new Error("applied record reply lost"); apply = true;
    is("applied cancellation with lost reply is uncertain", await uncertain(), true);
    is("applied cancellation remains canceled", JSON.parse(String((await original.call(redis, [["GET", key]]))[0])).status, "cancelled");
    saveReply = normal; apply = false;
    const recovered = await advanceBroadcast(id, async () => { throw new Error("cancelled campaign must not load sender"); }, Date.now() + 1000);
    is("worker observes applied cancellation without sending", recovered?.status, "cancelled");
    is("worker removes the retained queue entry", (await original.call(redis, [["SISMEMBER", queue, id]]))[0], 0);
    await seed(); removeReply = new Error("applied removal reply lost"); apply = true;
    is("lost applied queue response remains uncertain", await uncertain(), true);
    is("applied queue removal is not reversed", (await original.call(redis, [["SISMEMBER", queue, id]]))[0], 0);
    await seed(); await original.call(redis, [["SREM", queue, id]]);
    is("already absent queue membership is confirmed", await cancelBroadcast(store, id), true);
  } finally { redis.pipeline = original; }
  done();
}
void main();
