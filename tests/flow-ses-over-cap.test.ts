/**
 * Two findings of Claude 4 cloud AA on #4246 @eb65458a1f (15 November 2026), on what happens past SES_PARKS_PER_RUN.
 *
 * 1. Honesty (VR item 2). The studio's list of how a run stops (lib/flow-stop-rules.ts, kind "waits") still promised
 *    that an email waiting for room at the sending service "waits as long as it takes". Since the parks are bounded,
 *    that is no longer what the code does. The sentence now says it, with the code's own numbers: such a wait does not
 *    count against the usual waits up to SES_PARKS_PER_RUN times, only while the service is set up and ready; past that
 *    it counts like any other wait, and the run stops after the usual limit with a note.
 * 2. MR. Past the bound, a wait for SES room is counted as an ordinary wait, and WORST_COMMANDS_PER_RUN priced each
 *    counted wait at WAIT_COMMANDS_PER_TRY. But such a try reads Amazon's state and its 24 hours like any SES try.
 *    Measured here on the real code: one job whose only work is one over-bound SES try, against the per-try price
 *    WORST_COMMANDS_PER_RUN gives a counted wait (its MAX_WAITS_PER_RUN share, with every other term taken out).
 *
 * Synthetic store, in-memory Redis, the SES stand-in.
 */
import {
  HISTORY_COMMANDS_PER_STEP,
  MAX_RETRIES_BY_YOU,
  MAX_STEPS,
  MAX_WAITS_PER_RUN,
  QUEUE_COMMANDS_PER_STEP,
  RUN_START_COMMANDS,
  SES_PARKS_PER_RUN,
  SES_WAITS_PER_RUN,
  SES_WAIT_COMMANDS_PER_TRY,
  SES_WAKE_COMMANDS_PER_TRY,
  WORST_COMMANDS_PER_RUN,
} from "@/lib/flow-limits";
import { stopRules } from "@/lib/flow-stop-rules";
import { personOf, readRun } from "@/lib/flow-runs";
import { enroll, saveFlow, sendDueSteps, setFlowActive } from "@/lib/flows";
import { upsertContact } from "@/lib/contacts";
import { claimHandle, ensureListId, ensureStatsId, setMailSettings, setStripeAccount, setSubscription, storeForEmail, storeForHandle } from "@/lib/store";
import { redisPipeline } from "@/lib/redis";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";
import { paidPeriod } from "./billing-period-fixture";
import { ROOM } from "./data-room";
import { installSesMailFixture } from "./ses-mail-fixture";

const mail = installSesMailFixture({
  fallback: () => new Response(JSON.stringify({ object: "list", data: [], has_more: false })),
});
let commands = 0;
const pipeline = redis.pipeline.bind(redis);
redis.pipeline = ((list: (string | number)[][]) => {
  commands += list.length;
  return pipeline(list);
}) as typeof redis.pipeline;

async function main(): Promise<void> {
  part("1. The rule the studio shows says what the code does past the bound");
  const waits = stopRules({ steps: [{ id: "a" }] }, { condition: () => "", product: () => "" }).find((r) => r.kind === "waits")!.text;
  is("it no longer promises the email waits as long as it takes", /as long as it takes/i.test(waits), false);
  is(`it gives the bound, ${SES_PARKS_PER_RUN} times a run`, waits.includes(`${SES_PARKS_PER_RUN} times`), true);
  is("it says the bound holds only while the sending service is set up and ready", /set up and ready/.test(waits), true);
  is("it says that past it such a wait counts like any other, and the run stops with a note", /counts like any other wait/.test(waits) && /stops/.test(waits) && /note/.test(waits), true);
  is(`and it still gives the usual limit, ${MAX_WAITS_PER_RUN} times`, waits.includes(`${MAX_WAITS_PER_RUN} times`), true);

  part("2. One SES try past the bound costs no more than WORST_COMMANDS_PER_RUN prices a counted wait");
  redis.clear();
  mail.configure();
  delete process.env.MARKETING_DAILY_CAP;
  process.env.STRIPE_SECRET_KEY = "sk_test_workflows_only_a_stand_in";
  process.env.RESEND_API_KEY = "re_test_workflows_only_a_stand_in";
  await mail.setReady(true, { max24: 1_000, rate: 100 });
  const OWNER = "kestrel@example.com";
  await claimHandle(OWNER, "kestrelstudio", "Kestrel Studio", "");
  await ensureStatsId(OWNER);
  await ensureListId(OWNER);
  await setStripeAccount(OWNER, "acct_1TestKestrel001", true);
  await setSubscription(OWNER, { customerId: "cus_Kestrel01", subscriptionId: "sub_Kestrel01", active: true, tier: "pro", period: paidPeriod() });
  await setMailSettings(OWNER, { fromName: "Kestrel Studio", address: "1 Main St, Portland, OR 97201" });
  let store = (await storeForEmail(OWNER))!;
  const made = await saveFlow(store, { name: "Welcome", trigger: "tagged", tag: "welcome", steps: [{ id: "f000000000000001", delayHours: 0, subject: "Welcome", body: "Hello." }] });
  const flowId = made.ok ? made.flows.find((f) => f.name === "Welcome")!.id : "";
  await setFlowActive(store, flowId, true);
  store = (await storeForEmail(OWNER))!;
  await upsertContact(store.listId as string, "wren@example.com", { agreed: true, explicit: true, source: "free" }, ROOM);
  await enroll(store, "wren@example.com", { joined: false, tag: "welcome" });
  // The run has used every park it may: its next try that meets no room is a counted wait.
  redis.run(["HSET", `nl:wf:run:${flowId}:${personOf("wren@example.com")}`, "sesParks", SES_PARKS_PER_RUN]);
  // Amazon is set up and ready, its 24 hours full: every hour read in full, no room.
  await redisPipeline([["SET", `nl:ses:h:${new Date().toISOString().slice(0, 13)}`, 1_000_000]]);
  const before = commands;
  await sendDueSteps((handle) => storeForHandle(handle), Date.now() + 20_000);
  const job = commands - before;
  const run = await readRun(flowId, personOf("wren@example.com"));
  is("the try met no room and was counted as an ordinary wait", [run?.run.status, run?.run.waits], ["waiting", 1]);
  // The job's own work around the try: the lease scan, the look for parked steps (none parked: one read) and the due scan.
  const tryCost = job - 3;
  console.log(`one SES try past the bound: ${tryCost} commands (job ${job})`);
  const countedWaitPrice =
    (WORST_COMMANDS_PER_RUN - RUN_START_COMMANDS - (MAX_STEPS + MAX_RETRIES_BY_YOU) * (HISTORY_COMMANDS_PER_STEP + QUEUE_COMMANDS_PER_STEP) - SES_WAITS_PER_RUN * (SES_WAIT_COMMANDS_PER_TRY + SES_WAKE_COMMANDS_PER_TRY)) / MAX_WAITS_PER_RUN;
  is(`it stays within the price WORST_COMMANDS_PER_RUN gives each counted wait (${countedWaitPrice})`, tryCost <= countedWaitPrice, true);

  mail.restore();
  done();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
