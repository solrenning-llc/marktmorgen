/**
 * Workflows: bounded retries, explicit stop rules and a preview with no side
 * effects (lib/flow-retry.ts, lib/flow-stop-rules.ts, lib/flows.ts; added 18
 * October 2026, ClickFunnels audit row F23). Checked against the in-memory
 * Redis and a stand-in for the email provider:
 *
 *   - a wait with a known end is tried once, at that end; anything else after
 *     a delay that grows, up to a day;
 *   - a run waits MAX_WAITS_PER_RUN times at the most, then stops with
 *     nothing done at that step, says so, and leaves the queue;
 *   - one wait costs at most WAIT_COMMANDS_PER_TRY database commands, and
 *     the worst case per run counts every wait and every creator retry;
 *   - "try it again" is taken MAX_RETRIES_BY_YOU times a run, then refused;
 *   - every way a run stops is listed, from the workflow and the engine;
 *   - the preview writes nothing.
 */
import {
  HISTORY_COMMANDS_PER_STEP,
  MAX_RETRIES_BY_YOU,
  MAX_STEPS,
  MAX_WAITS_PER_RUN,
  MAX_WAIT_DAYS_PER_STEP,
  QUEUE_COMMANDS_PER_STEP,
  RUN_START_COMMANDS,
  WAIT_COMMANDS_PER_TRY,
  WORKFLOW_LIMITS,
  WORST_COMMANDS_PER_RUN,
} from "@/lib/flow-limits";
import { backoffSeconds, nextTry, stopWaiting } from "@/lib/flow-retry";
import { stopRules } from "@/lib/flow-stop-rules";
import { previewRun } from "@/lib/flow-paths";
import { personOf, readRun } from "@/lib/flow-runs";
import { enroll, resolveHeldRun, saveFlow, sendDueSteps, setFlowActive } from "@/lib/flows";
import { upsertContact } from "@/lib/contacts";
import { claimHandle, ensureListId, ensureStatsId, setMailSettings, setStripeAccount, setSubscription, storeForEmail, storeForHandle } from "@/lib/store";
import { redisPipeline } from "@/lib/redis";
import { allowanceWindow } from "@/lib/allowance-window";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";
import { paidPeriod } from "./billing-period-fixture";
import { ROOM } from "./data-room";
import { installSesMailFixture } from "./ses-mail-fixture";

const RealDate = Date;
// Reproduce the near-midnight boundary without depending on the CI clock.
const baseNow = Date.UTC(2026, 9, 19, 23, 59, 37);
let shift = 0;
// Keep Date.now and no-argument Date construction on the same synthetic day.
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

// Every command the code sends, counted.
let commands = 0;
const pipeline = redis.pipeline.bind(redis);
redis.pipeline = ((list: (string | number)[][]) => {
  commands += list.length;
  return pipeline(list);
}) as typeof redis.pipeline;

const run = () => sendDueSteps((handle) => storeForHandle(handle), Date.now() + 20_000);
const nowS = () => Math.floor(Date.now() / 1000);
const QUEUE = "nl:mail:flowq";
const queued = async (needle: string): Promise<number | null> => {
  const [flat] = await redisPipeline([["ZRANGEBYSCORE", QUEUE, 0, "+inf", "WITHSCORES"]]);
  const list = flat as string[];
  for (let i = 0; i + 1 < list.length; i += 2) if (list[i].endsWith(`|${needle}`)) return Number(list[i + 1]);
  return null;
};
const dayKey = () => `nl:mail:day:${new Date(Date.now()).toISOString().slice(0, 10)}`;

async function main(): Promise<void> {
  redis.clear();
  mail.configure();
  await mail.setReady(true, { max24: 50_000, rate: 100 });
  process.env.STRIPE_SECRET_KEY = "sk_test_workflows_only_a_stand_in";
  process.env.RESEND_API_KEY = "re_test_workflows_only_a_stand_in";
  process.env.MARKETING_DAILY_CAP = "1";

  part("When a waiting step is tried again");
  is("the fixture uses one clock for timestamps and UTC day keys", new Date().getTime(), Date.now());
  is("without a known end: 10 minutes, then three times longer each time, a day at the most", [1, 2, 3, 4, 5, 6, 7, 20].map(backoffSeconds), [600, 1800, 5400, 16200, 48600, 86400, 86400, 86400]);
  const t = 1_800_000_000;
  is("the month's emails: once, a minute after the window turns", nextTry("allowance", 1, t, { windowEnd: t + 5 * 86_400 }), t + 5 * 86_400 + 60);
  is("a pause: a minute after it ends", nextTry("paused", 1, t, { pauseUntil: t + 3_600 }), t + 3_660);
  is("the day's room: just after the next UTC day begins", nextTry("day", 4, t), (Math.floor(t / 86_400) + 1) * 86_400 + 300);
  const midnight = (Math.floor(t / 86_400) + 1) * 86_400;
  is("near midnight the daily retry retains the ten-minute minimum", nextTry("day", 1, midnight - 23), midnight + 577);
  is("after midnight the daily retry waits for the following day", nextTry("day", 1, midnight + 23), midnight + 86_400 + 300);
  is("an unknown end falls back to the growing delay", nextTry("allowance", 2, t, { windowEnd: null }), t + 1800);
  is("a list's portion: at least fifteen minutes", nextTry("portion", 1, t), t + 900);
  is("a run may wait while it is within both bounds", stopWaiting({ waits: MAX_WAITS_PER_RUN, since: t }, t + 86_400), null);
  is("one wait past the most a run may", /already waited/.test(stopWaiting({ waits: MAX_WAITS_PER_RUN + 1, since: t }, t) ?? ""), true);
  is(`a step waiting more than ${MAX_WAIT_DAYS_PER_STEP} days`, /more than 35 days/.test(stopWaiting({ waits: 2, since: t }, t + 36 * 86_400) ?? ""), true);
  is("a count that cannot be read stops it: unknown is not room", /could not be confirmed/.test(stopWaiting(null, t) ?? ""), true);

  part("The worst case per run counts every wait and every retry");
  is(
    "start, every step and each retry of the creator's, and every wait",
    WORST_COMMANDS_PER_RUN,
    RUN_START_COMMANDS + (MAX_STEPS + MAX_RETRIES_BY_YOU) * (HISTORY_COMMANDS_PER_STEP + QUEUE_COMMANDS_PER_STEP) + MAX_WAITS_PER_RUN * WAIT_COMMANDS_PER_TRY,
  );
  is("and the commercial review captures the bounds", [WORKFLOW_LIMITS.maxWaitsPerRun, WORKFLOW_LIMITS.maxWaitDaysPerStep, WORKFLOW_LIMITS.maxRetriesByYou, WORKFLOW_LIMITS.worstCommandsPerRun], [MAX_WAITS_PER_RUN, MAX_WAIT_DAYS_PER_STEP, MAX_RETRIES_BY_YOU, WORST_COMMANDS_PER_RUN]);

  part("Every way a run stops, listed");
  const rules = stopRules(
    {
      goal: { tag: "customer" },
      steps: [
        { id: "a", when: { if: "buyer" }, otherwise: "end" },
        { id: "b", next: "end" },
        { id: "c", when: { if: "lead" }, otherwise: "skip" },
      ],
    },
    { condition: () => "they have bought", product: () => "Guide" },
  );
  is("the goal, each ending condition and end, the last step, and the engine's own", rules.map((r) => [r.kind, r.step ?? null]), [
    ["goal", null],
    ["condition", 0],
    ["end_after", 1],
    ["condition", 2],
    ["last", 2],
    ["left", null],
    ["paused", null],
    ["refused", null],
    ["taken_out", null],
    ["waits", null],
    ["held", null],
  ]);
  is("the bounds are the code's numbers", [rules.find((r) => r.kind === "waits")!.text.includes(`${MAX_WAITS_PER_RUN} times`), rules.find((r) => r.kind === "held")!.text.includes(`up to ${MAX_RETRIES_BY_YOU} times`)], [true, true]);
  is("a workflow with no goal and no conditions still lists the engine's stops", stopRules({ steps: [{ id: "a" }] }, { condition: () => "", product: () => "" }).map((r) => r.kind), ["last", "left", "paused", "refused", "taken_out", "waits", "held"]);

  part("The preview writes nothing");
  const before = commands;
  const keys = redis.keys().length;
  previewRun({ id: "f", steps: [{ id: "a" }, { id: "b", when: { if: "buyer" }, otherwise: "end" }] }, { ids: [], buyer: true, tags: [], clicks: false, courses: {} }, new Set());
  is("no database command and no key", [commands - before, redis.keys().length - keys], [0, 0]);

  const OWNER = "hazel@example.com";
  await claimHandle(OWNER, "hazelwood", "Hazelwood Studio", "");
  await ensureStatsId(OWNER);
  await ensureListId(OWNER);
  await setStripeAccount(OWNER, "acct_1TestHazel00001", true);
  await setSubscription(OWNER, { customerId: "cus_Hazel0001", subscriptionId: "sub_Hazel0001", active: true, tier: "pro", period: paidPeriod() });
  await setMailSettings(OWNER, { fromName: "Hazelwood Studio", address: "1 Main St, Portland, OR 97201" });
  let store = (await storeForEmail(OWNER))!;
  const list = store.listId as string;
  const made = await saveFlow(store, { name: "Once", trigger: "tagged", tag: "once", steps: [{ id: "b000000000000001", delayHours: 0, subject: "Room for me?", body: "Hello." }] });
  const flowId = made.ok ? made.flows.find((f) => f.name === "Once")!.id : "";
  await setFlowActive(store, flowId, true);
  store = (await storeForEmail(OWNER))!;

  part("A run waits a bounded number of times, then stops");
  await upsertContact(list, "kai@example.com", { agreed: true, explicit: true, source: "free" }, ROOM);
  await enroll(store, "kai@example.com", { joined: false, tag: "once" });
  const kai = personOf("kai@example.com");
  // The company's room for list emails today is always used up.
  await redisPipeline([["SET", dayKey(), 1]]);
  await run();
  const first = await queued("kai@example.com");
  is("the first daily wait honors the ten-minute minimum near UTC midnight", first, Math.floor(baseNow / 1000) + 600);
  let perWait = 0;
  for (let i = 2; i <= MAX_WAITS_PER_RUN; i += 1) {
    const due = await queued("kai@example.com");
    if (due === null) break;
    shift += (due - nowS() + 1) * 1000;
    await redisPipeline([["SET", dayKey(), 1]]);
    const c = commands;
    await run();
    perWait = Math.max(perWait, commands - c);
  }
  const waited = await readRun(flowId, kai);
  is(`after ${MAX_WAITS_PER_RUN} waits it is still waiting, nothing sent, nothing written to its history`, [waited?.run.status, waited?.run.waits, sent.length, waited?.events.map((e) => e.state)], ["waiting", MAX_WAITS_PER_RUN, 0, ["started"]]);
  is(`one wait costs at most ${WAIT_COMMANDS_PER_TRY} database commands, the store's own reads included`, perWait <= WAIT_COMMANDS_PER_TRY && perWait > 0, true);
  const due = await queued("kai@example.com");
  shift += ((due ?? nowS()) - nowS() + 1) * 1000;
  await redisPipeline([["SET", dayKey(), 1]]);
  await run();
  const stopped = await readRun(flowId, kai);
  is("one wait more and the run stops, with nothing done at that step", [stopped?.run.status, stopped?.events.at(-1)?.state, sent.length], ["ended", "failed", 0]);
  is("its history says why", stopped?.events.at(-1)?.note.includes(`already waited ${MAX_WAITS_PER_RUN} times`), true);
  is("and it is no longer in the queue", await queued("kai@example.com"), null);
  delete process.env.MARKETING_DAILY_CAP;

  part("A wait for the month's emails is tried once, when the month turns");
  await upsertContact(list, "max@example.com", { agreed: true, explicit: true, source: "free" }, ROOM);
  await enroll(store, "max@example.com", { joined: false, tag: "once" });
  store = (await storeForEmail(OWNER))!;
  const window = allowanceWindow(store)!;
  await redisPipeline([["SET", `nl:mail:used:${list}:${window.id}`, 1_000_000_000]]);
  const c0 = commands;
  await run();
  const monthWait = commands - c0;
  is("queued for a minute after the store's window turns", await queued("max@example.com"), Math.floor(window.end / 1000) + 60);
  is(`that wait cost at most ${WAIT_COMMANDS_PER_TRY} database commands too`, monthWait <= WAIT_COMMANDS_PER_TRY && monthWait > 0, true);
  await redisPipeline([["DEL", `nl:mail:used:${list}:${window.id}`]]);

  part("Trying a held step again is bounded");
  await upsertContact(list, "lia@example.com", { agreed: true, explicit: true, source: "free" }, ROOM);
  await enroll(store, "lia@example.com", { joined: false, tag: "once" });
  const lia = personOf("lia@example.com");
  mail.setSesOutcome("lost");
  await run();
  is("a lost answer holds the run", (await readRun(flowId, lia))?.run.status, "held");
  const answers: string[] = [];
  for (let i = 0; i < MAX_RETRIES_BY_YOU + 1; i += 1) {
    answers.push(await resolveHeldRun(store, flowId, lia, "retry"));
    await run();
  }
  mail.setSesOutcome("ok");
  is(`taken ${MAX_RETRIES_BY_YOU} times, then refused`, answers, [...Array(MAX_RETRIES_BY_YOU).fill("ok"), "retry_limit"]);
  is("the run says how often it was tried again", (await readRun(flowId, lia))?.run.retries, MAX_RETRIES_BY_YOU);
  is("refused, it stays held for the creator's other choices", [(await readRun(flowId, lia))?.run.status, await resolveHeldRun(store, flowId, lia, "end")], ["held", "ok"]);

  mail.restore();
  done();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
}).finally(() => { globalThis.Date = RealDate; });
