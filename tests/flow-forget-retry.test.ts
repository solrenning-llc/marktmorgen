/**
 * Forgetting a store's workflows is safe to try again (#1927): the workflows
 * are deleted before their earlier versions, so when a version list's deletion
 * cannot be confirmed the first try throws, and the next try still finds that
 * history by the list's index and deletes it.
 */
import { forgetStoreWorkflows, readFlows, saveFlow } from "@/lib/flows";
import { claimHandle, ensureListId, ensureStatsId, setMailSettings, setStripeAccount, setSubscription, storeForEmail } from "@/lib/store";
import { store as redis } from "./redis-stub";
import { paidPeriod } from "./billing-period-fixture";
import { done, is } from "./check";

globalThis.fetch = (async () => {
  throw new Error("No outside request in this test");
}) as typeof fetch;

async function main(): Promise<void> {
  redis.clear();
  const owner = "flow-forget-retry@example.test";
  await claimHandle(owner, "flow-forget-retry", "Synthetic workflow", "");
  await ensureStatsId(owner);
  await ensureListId(owner);
  await setStripeAccount(owner, "acct_FlowForgetRetry", true);
  await setSubscription(owner, { customerId: "cus_FlowForgetRetry", subscriptionId: "sub_FlowForgetRetry", active: true, tier: "pro", period: paidPeriod() });
  await setMailSettings(owner, { fromName: "Synthetic sender", address: "SYNTHETIC ADDRESS" });
  const shop = (await storeForEmail(owner))!;
  const first = await saveFlow(shop, { name: "Synthetic workflow", trigger: "joined", steps: [{ delayHours: 0, subject: "Original subject", body: "Original content." }] });
  if (!first.ok) throw new Error("fixture workflow unavailable");
  const flow = first.flows[0];
  await saveFlow(shop, { ...flow, steps: flow.steps.map((s) => ({ ...s, subject: "New subject" })) });
  const key = `nl:wf:ver:${shop.listId}:${flow.id}`;
  is("one earlier version is kept", (await redis.pipeline([["LLEN", key]]))[0], 1);

  const base = redis.pipeline.bind(redis);
  redis.pipeline = (async (commands: (string | number)[][]) => {
    if (commands.some((c) => c[0] === "EVAL" && String(c[1]).startsWith("-- marktmorgen:flow-version-drop:"))) return [];
    return base(commands);
  }) as typeof redis.pipeline;
  let threw = false;
  try {
    await forgetStoreWorkflows(shop);
  } catch {
    threw = true;
  } finally {
    redis.pipeline = base;
  }
  is("the first try says it could not finish, with the workflows already gone", [threw, (await readFlows(shop.listId)).length], [true, 0]);
  is("the history is still there, so it was not taken for deleted", (await redis.pipeline([["LLEN", key]]))[0], 1);
  await forgetStoreWorkflows(shop);
  is("the next try finds it by the index and deletes it", (await redis.pipeline([["LLEN", key], ["SCARD", `nl:wf:ver:idx:${shop.listId}`]])), [0, 0]);
  done();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
