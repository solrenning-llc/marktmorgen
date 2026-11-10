/**
 * A store switched off after notices about its content (`store.suspended`,
 * lib/takedown.ts) sends nothing to its list: an email to the list
 * (lib/broadcasts.ts, advanceBroadcast) and a workflow step
 * (lib/flows.ts, sendDueSteps) wait, are neither dropped nor counted as sent,
 * and go out by themselves once the store is back on. A switch-off value that
 * is neither nothing nor a day ("unknown", as lib/store.ts reads it after
 * #3399) counts as switched off (CX-123 rule 24). A workflow step waits the
 * way every other workflow wait is bounded (lib/flow-retry.ts,
 * MAX_WAITS_PER_RUN), tried again a day later, each wait within
 * WAIT_COMMANDS_PER_TRY commands. Synthetic data only, in-memory Redis.
 */
import { readFileSync } from "node:fs";
import { LIST_RETRY_SECONDS, advanceBroadcast } from "@/lib/broadcasts";
import { MAX_WAITS_PER_RUN, WAIT_COMMANDS_PER_TRY } from "@/lib/flow-limits";
import { LONGEST_DELAY_SECONDS } from "@/lib/flow-retry";
import { personOf, readRun } from "@/lib/flow-runs";
import { enroll, saveFlow, sendDueSteps, setFlowActive } from "@/lib/flows";
import { upsertContact } from "@/lib/contacts";
import { type Store, claimHandle, ensureListId, ensureStatsId, noteTakedown, setMailSettings, setStripeAccount, setSubscription, storeForEmail, storeForHandle } from "@/lib/store";
import { redisPipeline } from "@/lib/redis";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";
import { paidPeriod } from "./billing-period-fixture";
import { ROOM } from "./data-room";
import { installSesMailFixture } from "./ses-mail-fixture";

const RealDate = Date;
const baseNow = Date.UTC(2026, 10, 9, 12, 0, 0);
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
const messages = mail.ses;

let commands = 0;
const pipeline = redis.pipeline.bind(redis);
redis.pipeline = ((list: (string | number)[][]) => {
  commands += list.length;
  return pipeline(list);
}) as typeof redis.pipeline;

const nowS = () => Math.floor(Date.now() / 1000);
/** The store as read, but with a switch-off value in no known shape: what lib/store.ts reads as "unknown". */
const unknownOff = async (handle: string): Promise<Store | null> => {
  const store = await storeForHandle(handle);
  return store ? { ...store, suspended: "unknown" } : null;
};
const FLOW_QUEUE = "nl:mail:flowq";
const queuedAt = async (email: string): Promise<number | null> => {
  const [flat] = await redisPipeline([["ZRANGEBYSCORE", FLOW_QUEUE, 0, "+inf", "WITHSCORES"]]);
  const list = flat as string[];
  for (let i = 0; i + 1 < list.length; i += 2) if (list[i].endsWith(`|${email}`)) return Number(list[i + 1]);
  return null;
};

async function main(): Promise<void> {
  redis.clear();
  mail.configure();
  await mail.setReady(true, { max24: 50_000, rate: 100 });
  process.env.RESEND_API_KEY = "re_test_suspended_store_mail_only";
  process.env.STRIPE_SECRET_KEY = "sk_test_suspended_store_mail_only";

  // ------------------------------------------------------------ an email to the list
  const owner = "paper@example.com";
  await claimHandle(owner, "paperbox", "Paper Box", "");
  await ensureListId(owner);
  await setSubscription(owner, { customerId: "cus_Paper0001", subscriptionId: "sub_Paper0001", active: true, tier: "pro", period: paidPeriod() });
  await setMailSettings(owner, { fromName: "Paper Box", address: "4 Paper Lane, Boston, MA 02108" });
  const store = (await storeForEmail(owner))!;
  const listId = store.listId!;
  const people = ["one@example.com", "two@example.com"];
  for (const email of people) await upsertContact(listId, email, { agreed: true, explicit: true, source: "free" }, ROOM);

  const listed = "333333333333333333333333";
  const due = "444444444444444444444444";
  const base = { listId, handle: store.handle, body: "Fresh stock this week.", productId: null, notProductId: null, who: "all", narrow: null, createdAt: nowS() - 100, sendAt: nowS() - 100, finishedAt: 0, sent: 0, note: "", failures: 0, tagged: true, test: null };
  await redisPipeline([
    ["SET", `nl:mail:bc:${listed}`, JSON.stringify({ ...base, id: listed, subject: "Half way", status: "sending", total: people.length, listed: true })],
    ["RPUSH", `nl:mail:bc:${listed}:to`, ...people],
    ["SET", `nl:mail:bc:${due}`, JSON.stringify({ ...base, id: due, subject: "Due now", status: "scheduled", total: 0, listed: false })],
    ["SADD", "nl:mail:queue", listed, due],
  ]);
  const record = async (id: string) => JSON.parse(String((await redisPipeline([["GET", `nl:mail:bc:${id}`]]))[0]));
  const inQueue = async (id: string) => (await redisPipeline([["SISMEMBER", "nl:mail:queue", id]]))[0];

  part("An email to the list while the store is switched off");
  await noteTakedown(owner, null, true);
  const held = await advanceBroadcast(listed, storeForHandle, Date.now() + 10_000);
  const heldDue = await advanceBroadcast(due, storeForHandle, Date.now() + 10_000);
  is("nothing goes out", messages.length, 0);
  is("both wait, nothing counted as sent", [held?.status, held?.sent, heldDue?.status, heldDue?.sent], ["waiting", 0, "waiting", 0]);
  is("each says why, and that it goes out once the store is back on", [/switched off/.test(held?.note ?? ""), /back on/.test(held?.note ?? ""), /switched off/.test(heldDue?.note ?? "")], [true, true, true]);
  is("both stay in line", [await inQueue(listed), await inQueue(due)], [1, 1]);
  is("the written-down list is kept whole; the due one makes no list while it waits", [(await redisPipeline([["LLEN", `nl:mail:bc:${listed}:to`]]))[0], (await redisPipeline([["EXISTS", `nl:mail:bc:${due}:to`]]))[0]], [2, 0]);
  is("tried again within the hour, not every run", (await record(listed)).retryAt, nowS() + LIST_RETRY_SECONDS);
  const before = commands;
  await advanceBroadcast(listed, storeForHandle, Date.now() + 10_000);
  is("before then a run reads only its lock and its record", [messages.length, commands - before <= 3], [0, true]);

  part("A switch-off value in no known shape counts as switched off (rule 24)");
  await noteTakedown(owner, null, false);
  shift += (LIST_RETRY_SECONDS + 1) * 1000;
  const unknown = await advanceBroadcast(listed, unknownOff, Date.now() + 10_000);
  const unknownDue = await advanceBroadcast(due, unknownOff, Date.now() + 10_000);
  is("nothing goes out, both still wait", [messages.length, unknown?.status, unknownDue?.status, unknown?.sent], [0, "waiting", "waiting", 0]);

  part("Back on: both go out by themselves");
  shift += (LIST_RETRY_SECONDS + 1) * 1000;
  const resumed = await advanceBroadcast(listed, storeForHandle, Date.now() + 10_000);
  is("the half-way one goes to everyone on its list, once", [resumed?.status, resumed?.sent, messages.length], ["sent", 2, 2]);
  const resumedDue = await advanceBroadcast(due, storeForHandle, Date.now() + 10_000);
  is("the due one makes its list and goes out", [resumedDue?.status, resumedDue?.sent, messages.length], ["sent", 2, 4]);
  is("both leave the line", [await inQueue(listed), await inQueue(due)], [0, 0]);

  // ------------------------------------------------------------ a workflow step
  const maker = "hazel@example.com";
  await claimHandle(maker, "hazelwood", "Hazelwood Studio", "");
  await ensureStatsId(maker);
  await ensureListId(maker);
  await setStripeAccount(maker, "acct_1TestHazel00001", true);
  await setSubscription(maker, { customerId: "cus_Hazel0001", subscriptionId: "sub_Hazel0001", active: true, tier: "pro", period: paidPeriod() });
  await setMailSettings(maker, { fromName: "Hazelwood Studio", address: "1 Main St, Portland, OR 97201" });
  let studio = (await storeForEmail(maker))!;
  const list = studio.listId as string;
  const made = await saveFlow(studio, { name: "Welcome", trigger: "tagged", tag: "hello", steps: [{ id: "b000000000000001", delayHours: 0, subject: "Welcome in", body: "Hello." }] });
  const flowId = made.ok ? made.flows.find((f) => f.name === "Welcome")!.id : "";
  await setFlowActive(studio, flowId, true);
  studio = (await storeForEmail(maker))!;
  const run = (load: (handle: string) => Promise<Store | null> = storeForHandle) => sendDueSteps(load, Date.now() + 20_000);
  const sentBefore = messages.length;

  part("A workflow step while the store is switched off");
  await upsertContact(list, "kai@example.com", { agreed: true, explicit: true, source: "free" }, ROOM);
  await enroll(studio, "kai@example.com", { joined: false, tag: "hello" });
  await noteTakedown(maker, null, true);
  const c0 = commands;
  const first = await run();
  const firstCost = commands - c0;
  is("nothing goes out, nothing counted as sent", [messages.length - sentBefore, first.sent], [0, 0]);
  is("the step waits, tried again a day later", [first.later, await queuedAt("kai@example.com")], [1, nowS() + LONGEST_DELAY_SECONDS]);
  is("the run is not ended", (await readRun(flowId, personOf("kai@example.com")))?.run.status === "ended", false);
  is(`that wait costs at most ${WAIT_COMMANDS_PER_TRY} commands, as every other workflow wait`, firstCost > 0 && firstCost <= WAIT_COMMANDS_PER_TRY, true);

  part("A switch-off value in no known shape: the step still waits (rule 24)");
  await noteTakedown(maker, null, false);
  shift += (LONGEST_DELAY_SECONDS + 1) * 1000;
  const second = await run(unknownOff);
  is("nothing goes out, the step waits again", [messages.length - sentBefore, second.sent, second.later, await queuedAt("kai@example.com")], [0, 0, 1, nowS() + LONGEST_DELAY_SECONDS]);

  part("Back on: the step goes out by itself");
  shift += (LONGEST_DELAY_SECONDS + 1) * 1000;
  const third = await run();
  is("sent once, to the one waiting", [third.sent, messages.length - sentBefore, messages.at(-1)?.to], [1, 1, ["kai@example.com"]]);
  is("and it leaves the line", await queuedAt("kai@example.com"), null);

  part("Switched off for longer than a run may wait: it stops as every workflow wait does");
  await upsertContact(list, "lee@example.com", { agreed: true, explicit: true, source: "free" }, ROOM);
  await enroll(studio, "lee@example.com", { joined: false, tag: "hello" });
  await noteTakedown(maker, null, true);
  for (let i = 1; i <= MAX_WAITS_PER_RUN; i += 1) {
    await run();
    const at = await queuedAt("lee@example.com");
    is(`wait ${i}: still waiting, nothing sent`, [at !== null, messages.length - sentBefore], [true, 1]);
    shift += ((at ?? nowS()) - nowS() + 1) * 1000;
  }
  await run();
  const stopped = await readRun(flowId, personOf("lee@example.com"));
  is("one wait more and the run stops, with nothing sent", [stopped?.run.status, messages.length - sentBefore, await queuedAt("lee@example.com")], ["ended", 1, null]);
  is("its history says why", stopped?.events.at(-1)?.note.includes(`already waited ${MAX_WAITS_PER_RUN} times`), true);

  part("The studio says so while the store is switched off");
  const page = readFileSync("app/studio/email/page.tsx", "utf8");
  const studioCode = readFileSync("components/email-studio.tsx", "utf8");
  is("the email page shows the pause, from the store's own switch-off", [page.includes("store.suspended ? ("), page.includes("Email from your store is paused while it is switched off")], [true, true]);
  is("an email sent while switched off is not said to be on its way", studioCode.includes("It goes out once your store is back on."), true);

  mail.restore();
  done();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
}).finally(() => { globalThis.Date = RealDate; });
