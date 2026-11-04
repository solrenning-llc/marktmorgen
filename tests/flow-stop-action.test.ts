/**
 * A workflow step that takes the person out of another sequence (635 [GL3];
 * added 2 November 2026), against the in-memory Redis double, a stand-in
 * email provider and synthetic stores only: the person waiting in the other
 * sequence is taken out where they are, its history says by what, they are
 * not started on it again, and someone not in it is told so.
 */
import { readFileSync } from "node:fs";
import { readAction } from "@/lib/flow-rules";
import { parseFlowList } from "@/lib/flow-list";
import { flowConfigurationIssues } from "@/lib/flow-review";
import { endedIfTakenOut, enroll, flowsStartedFor, readFlows, saveFlow, sendDueSteps } from "@/lib/flows";
import { listRuns } from "@/lib/flow-runs";
import { upsertContact } from "@/lib/contacts";
import { redisPipeline } from "@/lib/redis";
import { stepWhat } from "@/components/workflow-tools";
import { claimHandle, ensureListId, ensureStatsId, setMailSettings, setStripeAccount, setSubscription, storeForEmail, storeForHandle } from "@/lib/store";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";
import { paidPeriod } from "./billing-period-fixture";
import { ROOM } from "./data-room";

const sent: string[] = [];
// Runs while the stand-in provider is sending, for a stop that lands in the middle of a step.
let whileSending: ((subjects: string[]) => Promise<void>) | null = null;
globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const url = new URL(String(input));
  const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
  if (url.hostname === "api.resend.com") {
    const body = JSON.parse(String(init?.body)) as { subject: string } | { subject: string }[];
    for (const m of [body].flat()) sent.push(m.subject);
    if (whileSending) await whileSending([body].flat().map((m) => m.subject));
    return json(Array.isArray(body) ? { data: body.map((_, i) => ({ id: `e${sent.length}_${i}` })) } : { id: `e${sent.length}` });
  }
  return json({ object: "list", data: [], has_more: false });
}) as typeof fetch;

const run = () => sendDueSteps((handle) => storeForHandle(handle), Date.now() + 20_000);

async function main(): Promise<void> {
  redis.clear();
  process.env.STRIPE_SECRET_KEY = "sk_test_stop_only_a_stand_in";
  process.env.RESEND_API_KEY = "re_test_stop_only_a_stand_in";
  const OWNER = "stop@example.com";
  await claimHandle(OWNER, "stopper", "Stop Studio", "");
  await ensureStatsId(OWNER);
  await ensureListId(OWNER);
  await setStripeAccount(OWNER, "acct_1TestStop000001", true);
  await setSubscription(OWNER, { customerId: "cus_Stop00001", subscriptionId: "sub_Stop00001", active: true, tier: "pro", period: paidPeriod() });
  await setMailSettings(OWNER, { fromName: "Stop Studio", address: "1 Main St, Portland, OR 97201" });
  const store = (await storeForEmail(OWNER))!;
  const list = store.listId!;

  part("Read and kept");
  const nurture = await saveFlow(store, { name: "Nurture", trigger: "joined", active: true, steps: [{ delayHours: 24, subject: "Day one", body: "Hello." }, { delayHours: 24, subject: "Day two", body: "Again." }] }, { activate: true });
  const nurtureId = nurture.ok ? nurture.flows.find((f) => f.name === "Nurture")!.id : "";
  const isFlow = (id: string) => id === nurtureId;
  is("another of the store's sequences, never one that is not", [readAction({ do: "stop", flowId: nurtureId }, isFlow), readAction({ do: "stop", flowId: "0000000000000000" }, isFlow), readAction({ do: "stop" }, isFlow)], [{ do: "stop", flowId: nurtureId }, "bad", "bad"]);
  is("never the workflow itself", (await saveFlow(store, { id: nurtureId, name: "Nurture", trigger: "joined", active: true, steps: [{ delayHours: 0, action: { do: "stop", flowId: nurtureId } }] }, { activate: true })).ok, false);
  const buyer = await saveFlow(store, { name: "Bought", trigger: "tagged", tag: "bought", active: true, steps: [{ delayHours: 0, action: { do: "stop", flowId: nurtureId } }] }, { activate: true });
  is("saved, and the stored list reads it back", [buyer.ok, parseFlowList(JSON.parse(JSON.stringify(await readFlows(list)))) !== null], [true, true]);
  const flows = await readFlows(list);
  const buyerFlow = flows.find((f) => f.name === "Bought")!;

  part("Taken out where they are");
  await upsertContact(list, "ana@example.com", { agreed: true, explicit: true, source: "free" }, ROOM);
  await upsertContact(list, "ben@example.com", { agreed: true, explicit: true, source: "free" }, ROOM);
  await enroll(store, "ana@example.com", { joined: true });
  const waiting = async () => {
    const [members] = await redisPipeline([["ZRANGEBYSCORE", "nl:mail:flowq", "-inf", "+inf"]]);
    return (Array.isArray(members) ? members.map(String) : []).filter((m) => m.includes(`|${nurtureId}|`));
  };
  is("Ana waits in the nurture sequence for its first email", (await waiting()).length, 1);
  await enroll(store, "ana@example.com", { joined: false, tag: "bought" });
  await enroll(store, "ben@example.com", { joined: false, tag: "bought" });
  for (let i = 0; i < 4; i += 1) await run();
  is("taken out: nothing of hers waits in it", (await waiting()).length, 0);
  const runs = await listRuns(nurtureId, 10);
  is("its history says it ended, and by what", runs.filter((r) => r.email === "ana@example.com").map((r) => r.status), ["ended"]);
  await enroll(store, "ana@example.com", { joined: true });
  is("joining again does not start her on it again: each person goes through a sequence once", [(await waiting()).length, await flowsStartedFor(flows, "ana@example.com")], [0, [nurtureId, buyerFlow.id]]);
  is("no email of it went", sent.filter((s) => s === "Day one").length, 0);
  const benRuns = await listRuns(buyerFlow.id, 10);
  is("someone not in it is told so, in the step's history", benRuns.some((r) => r.email === "ben@example.com"), true);

  part("Waiting under an address the store had before");
  await upsertContact(list, "cy@example.com", { agreed: true, explicit: true, source: "free" }, ROOM);
  await enroll(store, "cy@example.com", { joined: true });
  const [cyEntry] = (await waiting()).filter((m) => m.endsWith("|cy@example.com"));
  const oldEntry = cyEntry.replace(`|${store.handle}|`, "|oldname|");
  await redisPipeline([["ZREM", "nl:mail:flowq", cyEntry], ["ZADD", "nl:mail:flowq", Math.floor(Date.now() / 1000) + 86_400, oldEntry]]);
  const renamed = { ...store, previousHandles: ["oldname"] };
  is("an entry made before the store changed its address", (await waiting()).includes(oldEntry), true);
  await enroll(renamed, "cy@example.com", { joined: false, tag: "bought" });
  for (let i = 0; i < 4; i += 1) await sendDueSteps(async (handle) => (handle === store.handle || handle === "oldname" ? renamed : storeForHandle(handle)), Date.now() + 20_000);
  is("is taken out too", (await waiting()).includes(oldEntry), false);

  part("Due in the same minute: the stop really cancels the email");
  // Found by the independent review: one pass takes both from the queue; the stop, done first, must keep the other
  // sequence's email from going, and leave nothing after it queued (sendGroup reads the lease before its attempt).
  const welcome = await saveFlow(store, { name: "Welcome", trigger: "tagged", tag: "welcome", active: true, steps: [{ delayHours: 0, subject: "Welcome one", body: "Hello." }, { delayHours: 24, subject: "Welcome two", body: "Again." }] }, { activate: true });
  const welcomeId = welcome.ok ? welcome.flows.find((f) => f.name === "Welcome")!.id : "";
  const paid = await saveFlow(store, { name: "Paid", trigger: "tagged", tag: "paid", active: true, steps: [{ delayHours: 0, action: { do: "stop", flowId: welcomeId } }] }, { activate: true });
  const paidId = paid.ok ? paid.flows.find((f) => f.name === "Paid")!.id : "";
  await upsertContact(list, "dee@example.com", { agreed: true, explicit: true, source: "free" }, ROOM);
  await enroll(store, "dee@example.com", { joined: false, tag: "welcome" });
  await enroll(store, "dee@example.com", { joined: false, tag: "paid" });
  const [queued] = await redisPipeline([["ZRANGEBYSCORE", "nl:mail:flowq", "-inf", "+inf"]]);
  const stopEntry = (queued as string[]).find((m) => m.includes(`|${paidId}|`) && m.endsWith("|dee@example.com"))!;
  await redisPipeline([["ZADD", "nl:mail:flowq", Math.floor(Date.now() / 1000) - 30, stopEntry]]);
  const before = sent.length;
  await run();
  const [after] = await redisPipeline([["ZRANGEBYSCORE", "nl:mail:flowq", "-inf", "+inf"]]);
  is(
    "the stop, done first in the batch, keeps the email from going, and nothing of that sequence is left queued for her",
    [sent.slice(before).includes("Welcome one"), (after as string[]).some((m) => m.includes(`|${welcomeId}|`) && m.endsWith("|dee@example.com"))],
    [false, false],
  );
  is(
    "both histories say so: taken out, not put off for later",
    [(await listRuns(welcomeId, 10)).filter((r) => r.email === "dee@example.com").map((r) => r.status), (await listRuns(paidId, 10)).some((r) => r.email === "dee@example.com" && r.status !== "held")],
    [["ended"], true],
  );

  part("A step under way when the stop lands");
  // The stop removes the lease entry while the email is with the sender: it still goes, but nothing after it is
  // queued, and the history says why (QUEUE_IF_LEASED, one command that checks and queues together).
  const mid = await saveFlow(store, { name: "Mid", trigger: "tagged", tag: "mid", active: true, steps: [{ delayHours: 0, subject: "Mid one", body: "Hello." }, { delayHours: 24, subject: "Mid two", body: "Again." }] }, { activate: true });
  const midId = mid.ok ? mid.flows.find((f) => f.name === "Mid")!.id : "";
  await upsertContact(list, "ivy@example.com", { agreed: true, explicit: true, source: "free" }, ROOM);
  await enroll(store, "ivy@example.com", { joined: false, tag: "mid" });
  whileSending = async (subjects) => {
    if (!subjects.includes("Mid one")) return;
    const [leased] = await redisPipeline([["ZRANGEBYSCORE", "nl:mail:flowq:lease", "-inf", "+inf"]]);
    const entry = (leased as string[]).find((m) => m.includes(`|${midId}|`) && m.endsWith("|ivy@example.com"));
    if (entry) await redisPipeline([["ZREM", "nl:mail:flowq:lease", entry]]);
  };
  const midBefore = sent.length;
  try {
    await run();
  } finally {
    whileSending = null;
  }
  const ivy = (await listRuns(midId, 10)).find((r) => r.email === "ivy@example.com");
  is(
    "the email under way goes, nothing after it is queued, and the run ends, saying why",
    [sent.slice(midBefore).includes("Mid one"), ((await redisPipeline([["ZRANGEBYSCORE", "nl:mail:flowq", "-inf", "+inf"]]))[0] as string[]).some((m) => m.includes(`|${midId}|`)), ivy?.status ?? ""],
    [true, false, "ended"],
  );
  const flowsSource = readFileSync("lib/flows.ts", "utf8");
  is(
    "every place a run is queued again after its step goes through the lease check",
    [flowsSource.includes("queueHeld([...queueNext(onwards), ...waiting.queue]"), flowsSource.includes("const out = await queueHeld(onQueue, tallies);"), flowsSource.includes("const skippedOut = await queueHeld(moved, tallies);"), flowsSource.includes("Taken out by another workflow, so nothing after this step is sent.")],
    [true, true, true, true],
  );

  part("Waiting for room to send when the stop lands");
  // The review's finding on c6b18967: a run put off at this step and taken out meanwhile ends there, never "waiting".
  const waits = [
    { email: "eve@example.com", state: "deferred" as const, note: "Waiting for room to send; it goes out by itself.", to: 0 },
    { email: "fay@example.com", state: "deferred" as const, note: "Waiting for room to send; it goes out by itself.", to: 0 },
  ];
  const settledWaits = endedIfTakenOut(waits, new Set(["fay@example.com"]));
  is(
    "taken out: ended there, said why; still in it: the wait as it was",
    settledWaits.map((o) => [o.email, o.status ?? "waiting", o.to]),
    [["eve@example.com", "ended", -1], ["fay@example.com", "waiting", 0]],
  );
  const flowsCode = readFileSync("lib/flows.ts", "utf8");
  is(
    "both places a step is put off use it, and a wait taken out is not counted as later",
    [flowsCode.includes("...endedIfTakenOut(waiting.outcomes, stay)]"), flowsCode.includes("outcomes.push(...endedIfTakenOut(waiting.outcomes, stay));"), flowsCode.includes("counts.later += later;")],
    [true, true, true],
  );

  // Both stops below run first in their batch: the other sequence's entry is moved a little earlier in the queue.
  const stopFirst = async (stopperId: string, email: string) => {
    const [all] = await redisPipeline([["ZRANGEBYSCORE", "nl:mail:flowq", "-inf", "+inf"]]);
    const entry = (all as string[]).find((m) => m.includes(`|${stopperId}|`) && m.endsWith(`|${email}`))!;
    await redisPipeline([["ZADD", "nl:mail:flowq", Math.floor(Date.now() / 1000) - 30, entry]]);
  };
  const inFlow = async (flowId: string, email: string) => {
    const [q] = await redisPipeline([["ZRANGEBYSCORE", "nl:mail:flowq", "-inf", "+inf"]]);
    const [l] = await redisPipeline([["ZRANGEBYSCORE", "nl:mail:flowq:lease", "-inf", "+inf"]]);
    return [...(q as string[]), ...(l as string[])].filter((m) => m.includes(`|${flowId}|`) && m.endsWith(`|${email}`));
  };

  part("A condition that sends them on, when the stop lands first");
  // Found by the independent review: someone the step's condition sends on was queued for the next step and their
  // run written back to "running" over the stop's "ended", before the lease was read.
  const cond = await saveFlow(store, { name: "Cond", trigger: "tagged", tag: "cond", active: true, steps: [{ delayHours: 0, subject: "Cond one", body: "Hello.", when: { if: "tag", tag: "neverthere" }, otherwise: "skip" }, { delayHours: 24, subject: "Cond two", body: "Again." }] }, { activate: true });
  is("the conditional sequence is saved", cond.ok, true);
  const condId = cond.ok ? cond.flows.find((f) => f.name === "Cond")!.id : "";
  const condStop = await saveFlow(store, { name: "Cond stop", trigger: "tagged", tag: "condstop", active: true, steps: [{ delayHours: 0, action: { do: "stop", flowId: condId } }] }, { activate: true });
  const condStopId = condStop.ok ? condStop.flows.find((f) => f.name === "Cond stop")!.id : "";
  await upsertContact(list, "gus@example.com", { agreed: true, explicit: true, source: "free" }, ROOM);
  await enroll(store, "gus@example.com", { joined: false, tag: "cond" });
  await enroll(store, "gus@example.com", { joined: false, tag: "condstop" });
  await stopFirst(condStopId, "gus@example.com");
  await run();
  is(
    "taken out before the condition is read: nothing of that sequence is queued for him, and his run stays ended",
    [await inFlow(condId, "gus@example.com"), (await listRuns(condId, 10)).filter((r) => r.email === "gus@example.com").map((r) => r.status)],
    [[], ["ended"]],
  );

  part("Out of time in the same batch, after the stop");
  // Found by the independent review: a group put back for the next run because the job ran out of time went back
  // in the queue whole, also for someone the stop had just taken out of it.
  const ds = await saveFlow(store, { name: "DS", trigger: "tagged", tag: "ds", active: true, steps: [{ delayHours: 0, subject: "DS one", body: "Hello." }, { delayHours: 24, subject: "DS two", body: "Again." }] }, { activate: true });
  const dsId = ds.ok ? ds.flows.find((f) => f.name === "DS")!.id : "";
  const dsStop = await saveFlow(store, { name: "DS stop", trigger: "tagged", tag: "dsstop", active: true, steps: [{ delayHours: 0, action: { do: "stop", flowId: dsId } }] }, { activate: true });
  const dsStopId = dsStop.ok ? dsStop.flows.find((f) => f.name === "DS stop")!.id : "";
  await upsertContact(list, "hal@example.com", { agreed: true, explicit: true, source: "free" }, ROOM);
  await enroll(store, "hal@example.com", { joined: false, tag: "ds" });
  await enroll(store, "hal@example.com", { joined: false, tag: "dsstop" });
  await stopFirst(dsStopId, "hal@example.com");
  // The clock jumps past the job's deadline as soon as the stop has taken him out of DS's lease.
  const realNow = Date.now;
  let late = false;
  const pipeline = redis.pipeline.bind(redis);
  redis.pipeline = ((commands: (string | number)[][]) => {
    if (commands.some((c) => c[0] === "ZREM" && c[1] === "nl:mail:flowq:lease" && c.slice(2).some((m) => String(m).includes(`|${dsId}|`) && String(m).endsWith("|hal@example.com")))) late = true;
    return pipeline(commands);
  }) as typeof redis.pipeline;
  Date.now = () => realNow() + (late ? 60_000 : 0);
  const dsBefore = sent.length;
  try {
    await sendDueSteps((handle) => storeForHandle(handle), realNow() + 20_000);
  } finally {
    redis.pipeline = pipeline;
    Date.now = realNow;
  }
  await run();
  is(
    "his DS step is not put back in the queue, no email of it goes, and his run stays ended",
    [late, await inFlow(dsId, "hal@example.com"), sent.slice(dsBefore).includes("DS one"), (await listRuns(dsId, 10)).filter((r) => r.email === "hal@example.com").map((r) => r.status)],
    [true, [], false, ["ended"]],
  );

  part("When the sequence is gone");
  is("the workflow's review says so", flowConfigurationIssues({ ...buyerFlow }, { products: [], courses: [], forms: [], fields: [], stages: [], flows: [] }).some((i) => i.includes("The sequence to take them out of is unavailable.")), true);

  part("Said in words");
  const studio = readFileSync("components/email-studio.tsx", "utf8");
  is("the studio's choice and what it does", [studio.includes('<option value="stop">Takes them out of another sequence</option>'), studio.includes("They stop where they are in it, also when it waits for your choice, and are not started on it again")], [true, true]);
  is("the map says it", stepWhat({ action: { do: "stop", flowId: nurtureId } } as Parameters<typeof stepWhat>[0]), "Take them out of another workflow");
}

void main().then(() => done(), (error) => {
  console.error(error);
  process.exit(1);
});
