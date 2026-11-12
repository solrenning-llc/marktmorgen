/**
 * startFlows claims the once-only start (SET NX of the enrolled mark), opens the run and only then queues its first
 * step (ZADD) with no check of that reply. When the queue write failed, the mark kept the same event from ever
 * starting the run again for 400 days: the run stayed "running" at step 0 and the welcome email never went (Claude 2
 * (nuvem D) bug hunt, lib/flows.ts). Synthetic: the memory Redis and the SES stand-in.
 */
import { personOf, readRun } from "@/lib/flow-runs";
import { enroll, saveFlow, sendDueSteps, setFlowActive } from "@/lib/flows";
import { upsertContact } from "@/lib/contacts";
import { claimHandle, ensureListId, ensureStatsId, setMailSettings, setStripeAccount, setSubscription, storeForEmail, storeForHandle } from "@/lib/store";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";
import { paidPeriod } from "./billing-period-fixture";
import { ROOM } from "./data-room";
import { installSesMailFixture } from "./ses-mail-fixture";

type Command = (string | number)[];
const realNow = Date.now;
let shift = 0;
Date.now = () => realNow() + shift;
const real = redis.pipeline.bind(redis);
let failLease = false;
redis.pipeline = (async (batch: Command[]) => {
  if (failLease && batch.length > 1 && batch[0][0] === "ZADD" && batch[0][1] === "nl:mail:flowq" && batch.at(-1)?.[0] === "HINCRBY") {
    failLease = false;
    throw new Error("Redis request failed with status 503");
  }
  return real(batch);
}) as typeof redis.pipeline;

const mail = installSesMailFixture({ fallback: () => new Response(JSON.stringify({ object: "list", data: [], has_more: false })) });
const run = () => sendDueSteps((handle) => storeForHandle(handle), Date.now() + 20_000).catch(() => null);

async function main(): Promise<void> {
  redis.clear();
  mail.configure();
  await mail.setReady(true, { max24: 50_000, rate: 100 });
  process.env.STRIPE_SECRET_KEY = "sk_test_workflows_only_a_stand_in";
  process.env.RESEND_API_KEY = "re_test_workflows_only_a_stand_in";
  const OWNER = "hunt-start@example.test";
  await claimHandle(OWNER, "huntstart", "Hunt Start", "");
  await ensureStatsId(OWNER);
  await ensureListId(OWNER);
  await setStripeAccount(OWNER, "acct_1TestHuntSrt", true);
  await setSubscription(OWNER, { customerId: "cus_HuntSrt001", subscriptionId: "sub_HuntSrt001", active: true, tier: "pro", period: paidPeriod() });
  await setMailSettings(OWNER, { fromName: "Hunt Start", address: "1 Main St, Portland, OR 97201" });
  let store = (await storeForEmail(OWNER))!;
  const list = store.listId as string;
  const made = await saveFlow(store, { name: "Welcome", trigger: "tagged", tag: "welcome", steps: [
    { id: "c000000000000001", delayHours: 0, subject: "Welcome, step one", body: "Hello." },
    { id: "c000000000000002", delayHours: 24 * 30, subject: "Welcome, step two", body: "Again." },
  ] });
  const flowId = made.ok ? made.flows.find((f) => f.name === "Welcome")!.id : "";
  await setFlowActive(store, flowId, true);
  store = (await storeForEmail(OWNER))!;
  const sentTo = (email: string) => mail.sesAttempts.filter((m) => m.subject === "Welcome, step one" && JSON.stringify(m).includes(email)).length;

  part("The first step's queue write fails after the once-only start was claimed");
  await upsertContact(list, "start@example.com", { agreed: true, explicit: true, source: "free" }, ROOM);
  failLease = true;
  await enroll(store, "start@example.com", { joined: false, tag: "welcome" }).catch(() => null);
  // The same event comes again (a retried webhook, the tag put on again): nothing can start the run any more.
  await enroll(store, "start@example.com", { joined: false, tag: "welcome" }).catch(() => null);
  for (let i = 0; i < 4; i += 1) { shift += 30 * 60_000; await run(); }
  const after = await readRun(flowId, personOf("start@example.com"));
  is("the welcome step went out once and the run moved on", [sentTo("start@example.com"), after?.run.step], [1, 1]);
  mail.restore();
  done();
}
main().catch((error) => { console.error(error); process.exit(1); });
