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
globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const url = new URL(String(input));
  const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
  if (url.hostname === "api.resend.com") {
    const body = JSON.parse(String(init?.body)) as { subject: string } | { subject: string }[];
    for (const m of [body].flat()) sent.push(m.subject);
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
  const flowsSource = readFileSync("lib/flows.ts", "utf8");
  is(
    "a step under way when the stop lands queues nothing after it, and says why",
    [flowsSource.includes("queueNext(result.done.filter((email) => stay.has(email)))"), flowsSource.includes("queueNext(onwards.filter((email) => stay.has(email)))"), flowsSource.includes("Taken out by another workflow, so nothing after this step is sent.")],
    [true, true, true],
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
    [flowsCode.includes("...endedIfTakenOut(waiting.outcomes, stay)]"), flowsCode.includes("outcomes.push(...endedIfTakenOut(waiting.outcomes, stay));"), flowsCode.includes("counts.later += later.length;")],
    [true, true, true],
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
