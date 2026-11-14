/**
 * RED (mail queue hunt): a sequence step's attempt is claimed for each person before the send (lib/flow-runs.ts,
 * claimAttempts) and every claim must be settled, so a run is never left "running" with an attempt open and unseen. lib/flows.ts sendDueSteps settles only result.done, result.rest and result.uncertain of sendTo;
 * but sendTo (lib/mail.ts) leaves out of all three anyone tokensFor no longer finds mailable (unsubscribed, bounced
 * or removed after the step read its rows, or a token write that lost its compare-and-set three times). That person's
 * attempt stays open, the run stays "running" at the step with no queue entry and nothing more ever done, its
 * history ends on "attempted", and it is not among the held runs the creator can see. Synthetic data only.
 */
import { personOf, readRun } from "@/lib/flow-runs";
import { enroll, saveFlow, sendDueSteps, setFlowActive } from "@/lib/flows";
import { leadsKey, upsertContact } from "@/lib/contacts";
import { claimHandle, ensureListId, ensureStatsId, setMailSettings, setStripeAccount, setSubscription, storeForEmail, storeForHandle } from "@/lib/store";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";
import { paidPeriod } from "./billing-period-fixture";
import { ROOM } from "./data-room";
import { installSesMailFixture } from "./ses-mail-fixture";

const mail = installSesMailFixture({
  fallback: () => new Response(JSON.stringify({ object: "list", data: [], has_more: false })),
});
const run = () => sendDueSteps((handle) => storeForHandle(handle), Date.now() + 20_000);

async function main(): Promise<void> {
  redis.clear();
  mail.configure();
  await mail.setReady(true, { max24: 50_000, rate: 100 });
  process.env.STRIPE_SECRET_KEY = "sk_test_workflows_only_a_stand_in";
  process.env.RESEND_API_KEY = "re_test_workflows_only_a_stand_in";

  const OWNER = "tam@example.com";
  await claimHandle(OWNER, "tam", "Tam Studio", "");
  await ensureStatsId(OWNER);
  await ensureListId(OWNER);
  await setStripeAccount(OWNER, "acct_1TestTam0000001", true);
  await setSubscription(OWNER, { customerId: "cus_Tam000001", subscriptionId: "sub_Tam000001", active: true, tier: "pro", period: paidPeriod() });
  await setMailSettings(OWNER, { fromName: "Tam Studio", address: "1 Main St, Portland, OR 97201" });
  let store = (await storeForEmail(OWNER))!;
  const list = store.listId as string;
  const made = await saveFlow(store, { name: "Welcome", trigger: "tagged", tag: "hello", steps: [{ id: "c000000000000001", delayHours: 0, subject: "Welcome aboard", body: "Hello." }] });
  const flowId = made.ok ? made.flows.find((f) => f.name === "Welcome")!.id : "";
  await setFlowActive(store, flowId, true);
  store = (await storeForEmail(OWNER))!;
  for (const email of ["bo@example.com", "cy@example.com"]) {
    await upsertContact(list, email, { agreed: true, explicit: true, source: "free" }, ROOM);
    await enroll(store, email, { joined: false, tag: "hello" });
  }
  const cy = personOf("cy@example.com");

  part("someone who leaves the list while their step is being sent is settled, not left open");
  // Cy unsubscribes in the moment between the step's attempt being claimed and the send reading the rows again.
  const pipeline = redis.pipeline.bind(redis);
  let left = false;
  redis.pipeline = (async (commands: (string | number)[][]) => {
    const reply = await pipeline(commands);
    if (!left && commands.some((c) => c[0] === "HSETNX" && String(c[1]).endsWith(`:${cy}`))) {
      left = true;
      const [raw] = await pipeline([["HGET", leadsKey(list), "cy@example.com"]]);
      await pipeline([["HSET", leadsKey(list), "cy@example.com", JSON.stringify({ ...JSON.parse(String(raw)), unsub: true })]]);
    }
    return reply;
  }) as typeof redis.pipeline;
  await run();
  redis.pipeline = pipeline;
  is("the unsubscribe landed mid-step", left, true);
  is("Bo got it; Cy did not", [mail.sesAttempts.filter((m) => m.to.includes("bo@example.com")).length, mail.sesAttempts.filter((m) => m.to.includes("cy@example.com")).length], [1, 0]);
  const found = await readRun(flowId, cy);
  is("Cy's attempt is not left open", found?.run.open ?? "", "");
  is("Cy's run has an outcome at the step, not a bare attempt", found?.events.at(-1)?.state === "attempted", false);
  is("Cy's run is over (left), not running", found?.run.status, "left");

  mail.restore();
  done();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
