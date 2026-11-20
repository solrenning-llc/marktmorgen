/**
 * Putting back a version that is already what the workflow does keeps no new version, and the studio says so, never
 * "the one it replaced is now at the top" (Claude 5's second review of #1927, LOW 2). Real saveFlow and
 * restoreFlowVersion (MemoryRedis); no outside request.
 */
import { readFileSync } from "node:fs";
import { readFlowVersions } from "@/lib/flow-versions";
import { restoreFlowVersion, saveFlow } from "@/lib/flows";
import { claimHandle, ensureListId, ensureStatsId, setMailSettings, setSubscription, storeForEmail } from "@/lib/store";
import { store as redis } from "./redis-stub";
import { paidPeriod } from "./billing-period-fixture";
import { done, is, part } from "./check";

globalThis.fetch = (async () => {
  throw new Error("No outside request in this test");
}) as typeof fetch;

async function main(): Promise<void> {
  redis.clear();
  const OWNER = "flow-same@example.test";
  await claimHandle(OWNER, "flowsame", "Flow Same", "");
  await ensureStatsId(OWNER);
  await ensureListId(OWNER);
  await setSubscription(OWNER, { customerId: "cus_FlowSame01", subscriptionId: "sub_FlowSame01", active: true, tier: "pro", period: paidPeriod() });
  await setMailSettings(OWNER, { fromName: "Flow Same", address: "1 Main St, Portland, OR 97201" });
  const store = (await storeForEmail(OWNER))!;
  const step = (body: string) => [{ delayHours: 0, subject: "Hello", body }];
  const first = await saveFlow(store, { name: "Welcome", trigger: "joined", steps: step("A") });
  const id = first.ok ? first.flows[0].id : "";
  const second = await saveFlow(store, { id, name: "Welcome", trigger: "joined", steps: step("B") });
  is("(two saves: the version doing A is kept)", second.ok, true);
  const [versionA] = await readFlowVersions(store.listId, id);

  part("Putting back a version that replaces what is in use");
  const putBack = await restoreFlowVersion(store, id, versionA.at);
  is("it is put back, and the one it replaced is kept", putBack.ok && putBack.kept, true);
  const versionsAfter = await readFlowVersions(store.listId, id);

  part("Putting back the same version again, now already in use");
  const sameAt = versionsAfter.find((v) => v.flow.steps[0]?.body === "A")!.at;
  const again = await restoreFlowVersion(store, id, sameAt);
  is("ok, and nothing new kept", [again.ok, again.ok ? again.kept : null], [true, false]);
  is("the kept versions are as they were", (await readFlowVersions(store.listId, id)).map((v) => v.at), versionsAfter.map((v) => v.at));

  part("What the studio says");
  const screen = readFileSync("components/workflow-versions.tsx", "utf8");
  const route = readFileSync("app/api/store/mail/route.ts", "utf8");
  is("the route says whether a version was kept", route.includes("kept: result.kept === true"), true);
  is("the screen says the replaced one is at the top only when one was kept", screen.includes("a.kept === true") && screen.includes("is already what this workflow does, so nothing changed and nothing new was kept."), true);
  done();
}
void main();
