/**
 * A workflows' write refused because another change came first never leaves their room below what is kept (Claude 5's
 * second review of #1927, LOW 1): the room only grows before a write and only shrinks after the write is confirmed,
 * so with the two reads after the refusal failing, what the other change kept is still counted. Real saveFlow writers
 * (MemoryRedis); no outside request.
 */
import { saveFlow } from "@/lib/flows";
import { claimHandle, ensureListId, ensureStatsId, setMailSettings, setSubscription, storeForEmail } from "@/lib/store";
import { dataKey } from "@/lib/store-data";
import { dataBytes } from "@/lib/store-data-rules";
import { store as redis } from "./redis-stub";
import { paidPeriod } from "./billing-period-fixture";
import { done, is, part } from "./check";

globalThis.fetch = (async () => {
  throw new Error("No outside request in this test");
}) as typeof fetch;

async function main(): Promise<void> {
  redis.clear();
  const OWNER = "flow-room@example.test";
  await claimHandle(OWNER, "flowroom", "Flow Room", "");
  await ensureStatsId(OWNER);
  await ensureListId(OWNER);
  await setSubscription(OWNER, { customerId: "cus_FlowRoom01", subscriptionId: "sub_FlowRoom01", active: true, tier: "pro", period: paidPeriod() });
  await setMailSettings(OWNER, { fromName: "Flow Room", address: "1 Main St, Portland, OR 97201" });
  const store = (await storeForEmail(OWNER))!;
  const key = `nl:mail:flows:${store.listId}`;
  const charged = () => Number(redis.run(["HGET", dataKey(store)!, "wf:defs"]));
  const required = () => {
    const raw = redis.run(["GET", key]) as string;
    return dataBytes([raw], 1 + (JSON.parse(raw) as unknown[]).length);
  };
  const short = { name: "Short", trigger: "joined", steps: [{ delayHours: 0, subject: "Hi", body: "Short." }] };
  const long = { name: "Long", trigger: "joined", steps: [{ delayHours: 0, subject: "Welcome", body: "L".repeat(8_000) }] };

  part("Control: one save at a time");
  is("saved", (await saveFlow(store, short)).ok, true);
  is("charged at least what is kept", charged() >= required(), true);

  part("A shorter save refused by a longer one, with both reads after the refusal failing");
  redis.clear();
  await claimHandle(OWNER, "flowroom", "Flow Room", "");
  await ensureStatsId(OWNER);
  await ensureListId(OWNER);
  await setSubscription(OWNER, { customerId: "cus_FlowRoom01", subscriptionId: "sub_FlowRoom01", active: true, tier: "pro", period: paidPeriod() });
  await setMailSettings(OWNER, { fromName: "Flow Room", address: "1 Main St, Portland, OR 97201" });
  const shop = (await storeForEmail(OWNER))!;
  const pipe = redis.pipeline.bind(redis);
  let phase = 0;
  let failedReads = 0;
  redis.pipeline = (async (cs: (string | number)[][]) => {
    // The shorter save reads the workflows; the longer one is then saved whole, before the shorter sets their room.
    if (phase === 0 && cs.some((c) => c[0] === "GET" && c[1] === `nl:mail:flows:${shop.listId}`)) {
      phase = 1;
      const read = await pipe(cs);
      redis.pipeline = pipe;
      await saveFlow(shop, long);
      redis.pipeline = spy;
      return read;
    }
    if (phase === 1 && failedReads < 2 && cs.some((c) => c[0] === "GET" && c[1] === `nl:mail:flows:${shop.listId}`)) {
      failedReads += 1;
      throw new Error("Redis request failed with status 503");
    }
    return pipe(cs);
  }) as typeof redis.pipeline;
  const spy = redis.pipeline;
  await saveFlow(shop, short).catch(() => null);
  redis.pipeline = pipe;
  const shopCharged = Number(redis.run(["HGET", dataKey(shop)!, "wf:defs"]));
  const raw = redis.run(["GET", `nl:mail:flows:${shop.listId}`]) as string;
  const shopRequired = dataBytes([raw], 1 + (JSON.parse(raw) as unknown[]).length);
  is("(the refusal was reached, and both reads after it failed)", [phase, failedReads], [1, 2]);
  is("what the other change kept is still counted", shopCharged >= shopRequired, true);
  done();
}
void main();
