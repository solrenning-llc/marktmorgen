/**
 * A workflow step waiting only for room at Amazon SES waits in the queue and is
 * never dropped (ALL-160, owner's rule LC: email waits in the Amazon queue and
 * is never discarded).
 *
 * Until this test, such a wait was counted like any other: after
 * MAX_WAITS_PER_RUN waits (about two hours with the growing delay) the run
 * stopped with nothing done at that step, and the email was never sent.
 *
 * Checked against the in-memory Redis and the SES stand-in:
 *   - with no SES room for many scheduled runs, far past MAX_WAITS_PER_RUN
 *     waits and past MAX_WAIT_DAYS_PER_STEP days, the run is still waiting,
 *     still in the queue, nothing sent, nothing stopped;
 *   - every scheduled run's database commands stay bounded, and a run with
 *     nothing it can send spends only a few;
 *   - once room returns, the email goes out once and the run moves on;
 *   - the waits counted against MAX_WAITS_PER_RUN are not used up by it.
 */
import { MAX_WAITS_PER_RUN, MAX_WAIT_DAYS_PER_STEP, WAIT_COMMANDS_PER_TRY } from "@/lib/flow-limits";
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

const RealDate = Date;
const baseNow = Date.UTC(2026, 9, 20, 9, 0, 0);
let shift = 0;
globalThis.Date = new Proxy(RealDate, {
  construct(target, args, newTarget) {
    return Reflect.construct(target, args.length ? args : [baseNow + shift], newTarget);
  },
  get(target, key, receiver) {
    return key === "now" ? () => baseNow + shift : Reflect.get(target, key, receiver);
  },
});

const mail = installSesMailFixture({
  fallback: () => new Response(JSON.stringify({ object: "list", data: [], has_more: false })),
});
const sent = mail.sesAttempts;

let commands = 0;
const pipeline = redis.pipeline.bind(redis);
redis.pipeline = ((list: (string | number)[][]) => {
  commands += list.length;
  return pipeline(list);
}) as typeof redis.pipeline;

const run = () => sendDueSteps((handle) => storeForHandle(handle), Date.now() + 20_000);
const QUEUE = "nl:mail:flowq";
const inQueue = async (needle: string): Promise<boolean> => {
  const [flat] = await redisPipeline([["ZRANGEBYSCORE", QUEUE, "-inf", "+inf"]]);
  return (flat as string[]).some((m) => m.endsWith(`|${needle}`));
};

async function main(): Promise<void> {
  redis.clear();
  mail.configure();
  delete process.env.MARKETING_DAILY_CAP;
  process.env.STRIPE_SECRET_KEY = "sk_test_workflows_only_a_stand_in";
  process.env.RESEND_API_KEY = "re_test_workflows_only_a_stand_in";
  // Amazon SES is set up but has no room for email sent many at a time.
  await mail.setReady(true, { max24: 0, rate: 100 });

  const OWNER = "wren@example.com";
  await claimHandle(OWNER, "wrenfield", "Wrenfield Studio", "");
  await ensureStatsId(OWNER);
  await ensureListId(OWNER);
  await setStripeAccount(OWNER, "acct_1TestWren000001", true);
  await setSubscription(OWNER, { customerId: "cus_Wren0001", subscriptionId: "sub_Wren0001", active: true, tier: "pro", period: paidPeriod() });
  await setMailSettings(OWNER, { fromName: "Wrenfield Studio", address: "1 Main St, Portland, OR 97201" });
  let store = (await storeForEmail(OWNER))!;
  const list = store.listId as string;
  const made = await saveFlow(store, {
    name: "Welcome",
    trigger: "tagged",
    tag: "welcome",
    steps: [
      { id: "c000000000000001", delayHours: 0, subject: "Welcome", body: "Hello." },
      { id: "c000000000000002", delayHours: 24, subject: "Day two", body: "Again." },
    ],
  });
  const flowId = made.ok ? made.flows.find((f) => f.name === "Welcome")!.id : "";
  await setFlowActive(store, flowId, true);
  store = (await storeForEmail(OWNER))!;

  await upsertContact(list, "ivy@example.com", { agreed: true, explicit: true, source: "free" }, ROOM);
  await enroll(store, "ivy@example.com", { joined: false, tag: "welcome" });
  const ivy = personOf("ivy@example.com");

  part("No SES room, run after run, far past the waits and days a run may otherwise wait");
  // Scheduled runs every hour for the first day, then once a day, to well past MAX_WAIT_DAYS_PER_STEP.
  const runs = 24 + MAX_WAIT_DAYS_PER_STEP + 5;
  let most = 0;
  const perRun: number[] = [];
  for (let i = 0; i < runs; i += 1) {
    const before = commands;
    await run();
    const used = commands - before;
    perRun.push(used);
    most = Math.max(most, used);
    shift += (i < 24 ? 3_600 : 86_400) * 1000;
  }
  const waiting = await readRun(flowId, ivy);
  is(
    "still waiting, still in the queue, nothing sent, nothing stopped",
    [waiting?.run.status, await inQueue("ivy@example.com"), sent.length, waiting?.events.some((e) => e.state === "failed" || e.state === "ended") ?? null],
    ["waiting", true, 0, false],
  );
  is(`well past ${MAX_WAITS_PER_RUN} waits and ${MAX_WAIT_DAYS_PER_STEP} days`, (shift / 1000) > (MAX_WAIT_DAYS_PER_STEP + 1) * 86_400, true);
  is("the waits a run may make for other reasons are not used up by it", (waiting?.run.waits ?? 0) <= MAX_WAITS_PER_RUN, true);
  is(`every scheduled run stays within ${2 * WAIT_COMMANDS_PER_TRY} database commands`, most <= 2 * WAIT_COMMANDS_PER_TRY, true);
  const idle = perRun.slice(-10);
  is("a scheduled run with nothing it can send spends only a few commands", Math.max(...idle) <= 4, true);

  part("Room returns: it goes out once, and the run moves on");
  await mail.setReady(true, { max24: 50_000, rate: 100 });
  await run();
  const after = await readRun(flowId, ivy);
  is("sent once, to that person", sent.map((m) => m.to), ["ivy@example.com"]);
  is("the run goes on to its next step", [after?.run.status, after?.events.at(-1)?.state], ["running", "confirmed"]);
  await run();
  is("not sent twice", sent.length, 1);

  mail.restore();
  done();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
}).finally(() => { globalThis.Date = RealDate; });
