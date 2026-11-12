/**
 * sendGroup reads the contacts' rows and claims each attempt; sendTo (lib/mail.ts) reads the rows again and leaves out
 * whoever left the list meanwhile (unsubscribed, bounced, removed). That person was in neither done, rest nor
 * uncertain, so settleAttempts never closed their attempt: nothing was sent (right), but the run stayed "running"
 * with an open attempt for good (Claude 2 (nuvem D) bug hunt, lib/flows.ts). Synthetic: the memory Redis and the SES
 * stand-in.
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
let leaveAfterRead: string | null = null;
redis.pipeline = (async (batch: Command[]) => {
  const values = await real(batch);
  if (leaveAfterRead && batch[0]?.[0] === "HMGET" && batch.length > 1 && batch.slice(1).every((c) => c[0] === "ZSCORE")) {
    // The person unsubscribes right after sendGroup read their row (before sendTo's own tokensFor read).
    const key = String(batch[0][1]);
    const [raw] = await real([["HGET", key, leaveAfterRead]]);
    const contact = JSON.parse(raw as string);
    await real([["HSET", key, leaveAfterRead, JSON.stringify({ ...contact, unsub: true, unsubAt: new Date().toISOString() })]]);
    leaveAfterRead = null;
  }
  return values;
}) as typeof redis.pipeline;

const mail = installSesMailFixture({ fallback: () => new Response(JSON.stringify({ object: "list", data: [], has_more: false })) });
const run = () => sendDueSteps((handle) => storeForHandle(handle), Date.now() + 20_000).catch(() => null);

async function main(): Promise<void> {
  redis.clear();
  mail.configure();
  await mail.setReady(true, { max24: 50_000, rate: 100 });
  process.env.STRIPE_SECRET_KEY = "sk_test_workflows_only_a_stand_in";
  process.env.RESEND_API_KEY = "re_test_workflows_only_a_stand_in";
  const OWNER = "hunt-race@example.test";
  await claimHandle(OWNER, "huntrace", "Hunt Race", "");
  await ensureStatsId(OWNER);
  await ensureListId(OWNER);
  await setStripeAccount(OWNER, "acct_1TestHuntRce", true);
  await setSubscription(OWNER, { customerId: "cus_HuntRce001", subscriptionId: "sub_HuntRce001", active: true, tier: "pro", period: paidPeriod() });
  await setMailSettings(OWNER, { fromName: "Hunt Race", address: "1 Main St, Portland, OR 97201" });
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

  part("Unsubscribed between the step's row read and the send");
  await upsertContact(list, "race@example.com", { agreed: true, explicit: true, source: "free" }, ROOM);
  await enroll(store, "race@example.com", { joined: false, tag: "welcome" });
  leaveAfterRead = "race@example.com";
  await run();
  const after = await readRun(flowId, personOf("race@example.com"));
  console.log(JSON.stringify(after?.run));
  is("nothing was sent to them", sentTo("race@example.com"), 0);
  is("the run is closed as left, with no attempt left open", [after?.run.status, after?.run.open], ["left", ""]);
  mail.restore();
  done();
}
main().catch((error) => { console.error(error); process.exit(1); });
