/**
 * The workflows' room is never left below what is kept by a second writer that lands between a write and the room
 * counted after it (Claude 4 on #1927, LEVE: lib/flows.ts set the room to its own bytes after a confirmed write, and
 * to the bytes it read again after a refused one, each in a pipeline of its own, so a longer change written and
 * counted in between was counted short). And a save alone is counted once, exactly. Real saveFlow writers
 * (MemoryRedis); no outside request.
 */
import { saveFlow } from "@/lib/flows";
import { claimHandle, ensureListId, ensureStatsId, setMailSettings, setSubscription, storeForEmail, type Store } from "@/lib/store";
import { dataKey } from "@/lib/store-data";
import { dataBytes } from "@/lib/store-data-rules";
import { store as redis } from "./redis-stub";
import { paidPeriod } from "./billing-period-fixture";
import { done, is, part } from "./check";

globalThis.fetch = (async () => {
  throw new Error("No outside request in this test");
}) as typeof fetch;

const OWNER = "flow-late@example.test";

async function freshStore(): Promise<Store> {
  redis.clear();
  await claimHandle(OWNER, "flowlate", "Flow Late", "");
  await ensureStatsId(OWNER);
  await ensureListId(OWNER);
  await setSubscription(OWNER, { customerId: "cus_FlowLate01", subscriptionId: "sub_FlowLate01", active: true, tier: "pro", period: paidPeriod() });
  await setMailSettings(OWNER, { fromName: "Flow Late", address: "1 Main St, Portland, OR 97201" });
  return (await storeForEmail(OWNER))!;
}

const charged = (store: Store) => Number(redis.run(["HGET", dataKey(store)!, "wf:defs"]) ?? 0);
const kept = (store: Store): unknown[] => JSON.parse((redis.run(["GET", `nl:mail:flows:${store.listId}`]) as string | null) ?? "[]") as unknown[];
const required = (store: Store) => {
  const raw = redis.run(["GET", `nl:mail:flows:${store.listId}`]) as string;
  return dataBytes([raw], 1 + (JSON.parse(raw) as unknown[]).length);
};
const flow = (name: string, body: string) => ({ name, trigger: "joined", steps: [{ delayHours: 0, subject: "Hi", body }] });
const isFlowsWrite = (cs: (string | number)[][]) => cs.some((c) => c[0] === "EVAL" && String(c[1]).startsWith("-- marktmorgen:flows-write-if"));

async function main(): Promise<void> {
  const pipe = redis.pipeline.bind(redis);

  part("Control: saves one at a time are counted once, exactly");
  {
    const store = await freshStore();
    const first = await saveFlow(store, flow("Long", "L".repeat(8_000)));
    is("saved", first.ok, true);
    is("counted exactly what is kept", charged(store), required(store));
    const id = first.ok ? (first.flows[0] as { id: string }).id : "";
    const shorter = await saveFlow(store, { ...flow("Long", "Now short."), id });
    is("edited shorter", shorter.ok, true);
    is("counted exactly what is kept after shrinking", charged(store), required(store));
    is("a second one added", (await saveFlow(store, flow("Second", "Two."))).ok, true);
    is("counted exactly what is kept after growing", charged(store), required(store));
  }

  part("A confirmed write, then a longer save written and counted before this write's room is");
  {
    const store = await freshStore();
    let reached = false;
    let other: boolean | null = null;
    const spy = (async (cs: (string | number)[][]) => {
      const replies = await pipe(cs);
      // The shorter save's write is confirmed; before anything else of it reaches the database, the longer save reads
      // that write, writes both and counts its own room.
      if (!reached && isFlowsWrite(cs) && Array.isArray(replies) && replies[0] === 1) {
        reached = true;
        redis.pipeline = pipe;
        other = (await saveFlow(store, flow("Long", "L".repeat(8_000)))).ok;
        redis.pipeline = spy;
      }
      return replies;
    }) as typeof redis.pipeline;
    redis.pipeline = spy;
    const mine = await saveFlow(store, flow("Short", "Short.")).catch(() => null);
    redis.pipeline = pipe;
    is("(both saves went through, the longer one between)", [reached, mine?.ok, other, kept(store).length], [true, true, true, 2]);
    is("never counted below what is kept", charged(store) >= required(store), true);
    is("nor counted twice", charged(store), required(store));
  }

  part("A refused write, then a longer save written and counted before this save is done with the room");
  {
    const store = await freshStore();
    let reads = 0;
    const others: boolean[] = [];
    const spy = (async (cs: (string | number)[][]) => {
      if (!cs.some((c) => c[0] === "GET" && c[1] === `nl:mail:flows:${store.listId}`)) return pipe(cs);
      reads += 1;
      // Third read and on: the database answers no more, so no further try counts the room again.
      if (reads >= 3) throw new Error("Redis request failed with status 503");
      const replies = await pipe(cs);
      // After the first read another save comes first, so this one is refused; after the second, a longer one.
      redis.pipeline = pipe;
      others.push((await saveFlow(store, reads === 1 ? flow("Middle", "M".repeat(400)) : flow("Long", "L".repeat(8_000)))).ok);
      redis.pipeline = spy;
      return replies;
    }) as typeof redis.pipeline;
    redis.pipeline = spy;
    await saveFlow(store, flow("Short", "Short.")).catch(() => null);
    redis.pipeline = pipe;
    is("(the two other saves went through; this one's last read failed)", [others, reads, kept(store).length], [[true, true], 3, 2]);
    is("never counted below what is kept", charged(store) >= required(store), true);
    is("nor counted twice", charged(store), required(store));
  }
  done();
}
void main();
