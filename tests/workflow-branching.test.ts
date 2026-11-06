/**
 * Workflows: branches, goals, limits, the preview and each run's history
 * (lib/flow-paths.ts, lib/flow-limits.ts, lib/flow-runs.ts, lib/flows.ts;
 * added 17 October 2026). Checked, against the in-memory Redis and a stand-in
 * for the email provider:
 *
 *   - routes only go forward; a backward or missing target is refused;
 *   - the preview is deterministic and follows IF/ELSE, label steps and goals;
 *   - a new workflow is saved paused even when "on" is sent; switching on is
 *     its own step, bounded by the plan's active workflows;
 *   - an IF/ELSE sends each person down exactly one branch, and a label goal
 *     ends a run before its next step;
 *   - every step is written down attempted, then confirmed or skipped;
 *   - the daily run ceiling refuses starts past it and counts them;
 *   - an email whose answer was lost is held, not sent again on the next run,
 *     and only the creator's choice moves it on, once;
 *   - an attempt left open by a run that stopped is held, never repeated;
 *   - an abandoned-checkout workflow needs a goal; opening a course is a
 *     course; a teammate must be allowed to own deals.
 */
import { afterIndex, checkRoutes, elseIndex, previewRun } from "@/lib/flow-paths";
import { MAX_STEPS, TRIAL_ACTIVE_FLOWS, activeFlowLimit, dailyRunLimit, startableFlows } from "@/lib/flow-limits";
import { enroll, forgetStoreWorkflows, forgetWorkflowPerson, readFlows, removeFlow, resolveHeldRun, saveFlow, sendDueSteps, setFlowActive } from "@/lib/flows";
import { listHeld, listRuns, personOf, readRun, runsToday } from "@/lib/flow-runs";
import { leadsKey, upsertContact } from "@/lib/contacts";
import { addProduct, claimHandle, ensureListId, ensureStatsId, setMailSettings, setStripeAccount, setSubscription, storeForEmail, storeForHandle } from "@/lib/store";
import { redisPipeline } from "@/lib/redis";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";
import { paidPeriod } from "./billing-period-fixture";
import { ROOM } from "./data-room";
import { installSesMailFixture } from "./ses-mail-fixture";

const HOUR = 3_600_000;
const realNow = Date.now;
// Start the synthetic scenario at UTC noon. Keep elapsed wall time for lock
// deadlines, but never let the host's hour move the +79h scenario across a
// UTC day between admission and its daily-counter assertion.
const clockStartedAt = realNow();
const scenarioStartedAt = new Date(clockStartedAt);
scenarioStartedAt.setUTCHours(12, 0, 0, 0);
let shift = 0;
Date.now = () => scenarioStartedAt.getTime() + (realNow() - clockStartedAt) + shift;

const mail = installSesMailFixture({
  fallback: () => new Response(JSON.stringify({ object: "list", data: [], has_more: false })),
});
const to = (subject: string) =>
  mail.sesAttempts.filter((message) => message.subject === subject).flatMap((message) => message.to).sort();
const run = () => sendDueSteps((handle) => storeForHandle(handle), Date.now() + 20_000);
const later = async (hours: number) => {
  shift += hours * HOUR;
  await run();
};
const id = (n: number) => n.toString(16).padStart(16, "0");

async function main(): Promise<void> {
  redis.clear();
  mail.configure();
  await mail.setReady(true, { max24: 50_000, rate: 100 });
  process.env.STRIPE_SECRET_KEY = "sk_test_workflows_only_a_stand_in";
  process.env.RESEND_API_KEY = "re_test_workflows_only_a_stand_in";

  part("Routes go forward only");
  const linear = [{ id: id(1) }, { id: id(2) }, { id: id(3) }];
  is("after a step: the next, or the end after the last", [afterIndex(linear, 0), afterIndex(linear, 2)], [1, -1]);
  const branch = [
    { id: id(1), when: { if: "buyer" as const }, otherwise: "jump" as const, jump: id(3), next: id(4) },
    { id: id(2) },
    { id: id(3) },
    { id: id(4), next: "end" },
  ];
  is("IF/ELSE: yes goes to `next`, no to `jump`", [afterIndex(branch, 0), elseIndex(branch, 0), afterIndex(branch, 3)], [3, 2, -1]);
  is("a good set of routes passes", checkRoutes(branch), null);
  is("a jump back is refused", checkRoutes([{ id: id(1) }, { id: id(2), when: { if: "lead" }, otherwise: "jump", jump: id(1) }]), 1);
  is("a next to itself is refused", checkRoutes([{ id: id(1), next: id(1) }]), 0);
  is("a jump with no condition is refused", checkRoutes([{ id: id(1), otherwise: "jump", jump: id(2) }, { id: id(2) }]), 0);
  is("a target that is not in the workflow is refused", checkRoutes([{ id: id(1), next: id(9) }]), 0);

  part("The preview is the job's path, decided only by the sample");
  const previewSteps = [
    { id: id(1), subject: "Hello" },
    { id: id(2), when: { if: "buyer" as const }, otherwise: "jump" as const, jump: id(4), subject: "For buyers", next: id(5) },
    { id: id(3), subject: "never reached" },
    { id: id(4), subject: "For everyone else", action: { do: "tag" as const, tag: "warm" } },
    { id: id(5), when: { if: "tag" as const, tag: "warm" }, otherwise: "end" as const, subject: "Warm only" },
  ];
  const lead = previewRun({ id: "f", steps: previewSteps }, { ids: [], buyer: false, tags: [], clicks: false, courses: {} }, new Set());
  is("a lead: hello, skipped to the else branch, labeled, then the warm email", lead.path.map((p) => [p.index, p.outcome, p.to]), [[0, "runs", 1], [1, "skipped", 3], [3, "runs", 4], [4, "runs", -1]]);
  is("and the label the workflow gave is carried to the end", lead.tags, ["warm"]);
  const buyer = previewRun({ id: "f", steps: previewSteps }, { ids: [], buyer: true, tags: [], clicks: false, courses: {} }, new Set());
  is("a buyer: the buyers' branch, then the warm condition ends the run", [buyer.path.map((p) => [p.index, p.outcome]), buyer.end], [[[0, "runs"], [1, "runs"], [4, "skipped"]], "condition"]);
  is("the same sample gives the same path", JSON.stringify(previewRun({ id: "f", steps: previewSteps }, { ids: [], buyer: true, tags: [], clicks: false, courses: {} }, new Set())), JSON.stringify(buyer));
  const goal = previewRun({ id: "f", steps: previewSteps, goal: { tag: "warm" } }, { ids: [], buyer: false, tags: [], clicks: false, courses: {} }, new Set());
  is("a label goal ends the run before the step after the label is given", [goal.end, goal.goalBefore], ["goal", 4]);

  part("Limits, by plan");
  const view = (tier: "creator" | "pro" | "scale", trialEnds = 0) => ({ tier, subscriptionActive: true, trialEnds });
  is("active workflows: Store none, Studio 10, Scale 20, trial 3", [activeFlowLimit(view("creator")), activeFlowLimit(view("pro")), activeFlowLimit(view("scale")), activeFlowLimit(view("pro", Date.now() / 1000 + 86_400))], [0, 10, 20, TRIAL_ACTIVE_FLOWS]);
  is("runs a day: Store none, Studio 18, Scale 29, trial 7", [dailyRunLimit(view("creator")), dailyRunLimit(view("pro")), dailyRunLimit(view("scale")), dailyRunLimit(view("pro", Date.now() / 1000 + 86_400))], [0, 18, 29, 7]);
  is("over the limit after a move down, the oldest switched on keep starting people", startableFlows([{ id: "b", active: true, createdAt: 2 }, { id: "a", active: true, createdAt: 1 }, { id: "c", active: false, createdAt: 0 }], 1).map((f) => f.id), ["a"]);

  const OWNER = "willow@example.com";
  await claimHandle(OWNER, "willow", "Willow Studio", "");
  await ensureStatsId(OWNER);
  await ensureListId(OWNER);
  await setStripeAccount(OWNER, "acct_1TestWillow0001", true);
  await setSubscription(OWNER, { customerId: "cus_Willow0001", subscriptionId: "sub_Willow0001", active: true, tier: "pro", period: paidPeriod() });
  await setMailSettings(OWNER, { fromName: "Willow Studio", address: "1 Main St, Portland, OR 97201" });
  const guide = await addProduct(OWNER, "Planting Guide", "A guide.", "29", null);
  if (!guide.ok) throw new Error("no product");
  let store = (await storeForEmail(OWNER))!;
  const list = store.listId as string;

  part("Saved, and checked when saved");
  const tooMany = Array.from({ length: MAX_STEPS + 1 }, (_, i) => ({ delayHours: 0, subject: `S${i}`, body: "B" }));
  is(`up to ${MAX_STEPS} steps`, [(await saveFlow(store, { name: "Long", trigger: "joined", steps: tooMany.slice(0, MAX_STEPS) })).ok, await saveFlow(store, { name: "Too long", trigger: "joined", steps: tooMany })], [true, { ok: false, reason: "steps" }]);
  is("a branch back is refused", await saveFlow(store, { name: "Loop", trigger: "joined", steps: [{ id: id(1), delayHours: 0, subject: "a", body: "b" }, { id: id(2), delayHours: 0, subject: "c", body: "d", when: { if: "lead" }, otherwise: "jump", jump: id(1) }] }), { ok: false, reason: "route" });
  is("two steps with one id are refused", await saveFlow(store, { name: "Twins", trigger: "joined", steps: [{ id: id(1), delayHours: 0, subject: "a", body: "b" }, { id: id(1), delayHours: 0, subject: "c", body: "d" }] }), { ok: false, reason: "step" });
  is("an abandoned checkout needs a goal", await saveFlow(store, { name: "Cart", trigger: "abandoned", productId: guide.product.id, steps: [{ delayHours: 1, subject: "a", body: "b" }] }), { ok: false, reason: "goal" });
  is("and is saved with one", (await saveFlow(store, { name: "Cart", trigger: "abandoned", productId: guide.product.id, goal: { productId: guide.product.id }, steps: [{ delayHours: 1, subject: "a", body: "b" }] })).ok, true);
  is("opening a course needs a course", await saveFlow(store, { name: "Opened", trigger: "started", productId: guide.product.id, steps: [{ delayHours: 1, subject: "a", body: "b" }] }), { ok: false, reason: "product" });
  is("a deal owner must be on the team with orders", await saveFlow(store, { name: "Owner", trigger: "joined", steps: [{ delayHours: 0, action: { do: "assign", assignee: "stranger@example.com" } }] }), { ok: false, reason: "step" });
  is("the owner may own a deal", (await saveFlow(store, { name: "Owner", trigger: "joined", steps: [{ delayHours: 0, action: { do: "assign", assignee: OWNER } }] })).ok, true);

  // A clean slate of workflows for the runs below.
  await redisPipeline([["DEL", `nl:mail:flows:${list}`]]);
  const saved = await saveFlow(store, {
    name: "Welcome",
    trigger: "joined",
    active: true,
    goal: { tag: "customer" },
    steps: [
      { id: id(11), delayHours: 0, subject: "Welcome", body: "Hello." },
      { id: id(12), delayHours: 24, subject: "For buyers", body: "Thanks.", when: { if: "buyer" }, otherwise: "jump", jump: id(14), next: id(15) },
      { id: id(13), delayHours: 0, subject: "Never sent", body: "Nobody comes here." },
      { id: id(14), delayHours: 24, subject: "Still deciding?", body: "Here is the guide." },
      { id: id(15), delayHours: 24, subject: "Last one", body: "Bye." },
    ],
  });
  const flow = saved.ok ? saved.flows[0] : null;
  is("a new workflow is saved paused, even when it is sent switched on", flow?.active, false);
  await upsertContact(list, "ana@example.com", { agreed: true, explicit: true, source: "free" }, ROOM);
  await upsertContact(list, "ben@example.com", { agreed: true, explicit: true, source: "buyer", productId: guide.product.id, title: "Planting Guide" }, ROOM);
  store = (await storeForEmail(OWNER))!;
  await enroll(store, "ana@example.com", { joined: true });
  is("paused, it starts nobody", (await listRuns(flow!.id, 10)).length, 0);
  is("switching on is its own step", (await setFlowActive(store, flow!.id, true)).ok, true);

  part("One branch each, and the history of every step");
  for (const email of ["ana@example.com", "ben@example.com"]) await enroll(store, email, { joined: true });
  await run();
  is("the welcome goes to both", to("Welcome"), ["ana@example.com", "ben@example.com"]);
  await later(24);
  is("IF: only the buyer gets the buyers' email", to("For buyers"), ["ben@example.com"]);
  is("ELSE: the lead goes straight to the step for everyone else, after its own wait", to("Still deciding?"), []);
  await later(24);
  is("then the lead gets it, and the buyer skips past it to the last", [to("Still deciding?"), to("Last one")], [["ana@example.com"], ["ben@example.com"]]);
  is("the step between the branches is never sent", to("Never sent"), []);
  const ana = await readRun(flow!.id, personOf("ana@example.com"));
  is("Ana's history: started, then each step attempted and confirmed, or skipped", ana?.events.map((e) => [e.step, e.state]), [[-1, "started"], [0, "attempted"], [0, "confirmed"], [1, "skipped"], [3, "attempted"], [3, "confirmed"]]);
  // Ana gets the goal's label before her last step.
  const [row] = await redisPipeline([["HGET", leadsKey(list), "ana@example.com"]]);
  const contact = JSON.parse(String(row));
  await redisPipeline([["HSET", leadsKey(list), "ana@example.com", JSON.stringify({ ...contact, tags: ["customer"] })]]);
  await later(24);
  is("a label goal ends her run before the last email", to("Last one"), ["ben@example.com"]);
  is("and her run says so", [(await readRun(flow!.id, personOf("ana@example.com")))?.run.status, (await readRun(flow!.id, personOf("ben@example.com")))?.run.status], ["goal", "done"]);

  part("A lost answer is held, never sent again by itself");
  const lost = await saveFlow(store, { name: "Lost", trigger: "tagged", tag: "lost", steps: [{ id: id(21), delayHours: 0, subject: "Maybe sent", body: "?" }, { id: id(22), delayHours: 0, subject: "After it", body: "!" }] });
  const lostId = lost.ok ? lost.flows.find((f) => f.name === "Lost")!.id : "";
  await setFlowActive(store, lostId, true);
  await enroll(store, "cleo@example.com", { joined: false, tag: "lost" });
  is("only somebody on the list is started", (await listRuns(lostId, 10)).length, 0);
  await upsertContact(list, "cleo@example.com", { agreed: true, explicit: true, source: "free" }, ROOM);
  await enroll(store, "cleo@example.com", { joined: false, tag: "lost" });
  mail.setSesOutcome("lost");
  await run();
  mail.setSesOutcome("ok");
  is("the provider got it once, but said nothing back", to("Maybe sent"), ["cleo@example.com"]);
  const held = await readRun(lostId, personOf("cleo@example.com"));
  is("the run is held at that step, uncertain", [held?.run.status, held?.events.at(-1)?.state], ["held", "uncertain"]);
  await later(1);
  await later(6);
  is("later runs do not send it again", to("Maybe sent"), ["cleo@example.com"]);
  is("the store's held runs list it", (await listHeld(list)).map((h) => h.flowId), [lostId]);
  is("the creator says it went through: on to the next step", await resolveHeldRun(store, lostId, personOf("cleo@example.com"), "continue"), "ok");
  is("a second answer for the same hold is refused", await resolveHeldRun(store, lostId, personOf("cleo@example.com"), "retry"), "not_held");
  await run();
  is("the next step goes out, and the uncertain one was not repeated", [to("Maybe sent"), to("After it")], [["cleo@example.com"], ["cleo@example.com"]]);
  is("and the hold is gone", (await listHeld(list)).length, 0);

  part("An attempt left open by a run that stopped is held");
  await upsertContact(list, "dan@example.com", { agreed: true, explicit: true, source: "free" }, ROOM);
  await enroll(store, "dan@example.com", { joined: false, tag: "lost" });
  // As if a run wrote the attempt and was cut off before the outcome.
  await redisPipeline([["HSET", `nl:wf:run:${lostId}:${personOf("dan@example.com")}`, "open", `0:${id(21)}`]]);
  await run();
  is("nothing is sent for it", to("Maybe sent").includes("dan@example.com"), false);
  is("and the run is held for the creator", (await readRun(lostId, personOf("dan@example.com")))?.run.status, "held");
  is("trying it again is the creator's explicit choice", await resolveHeldRun(store, lostId, personOf("dan@example.com"), "retry"), "ok");
  await run();
  is("then it goes out", to("Maybe sent").includes("dan@example.com"), true);

  part("Runs a day");
  await setSubscription(OWNER, { customerId: "cus_Willow0001", subscriptionId: "sub_Willow0001", active: true, tier: "pro", period: paidPeriod() });
  store = (await storeForEmail(OWNER))!;
  const today = await runsToday(list);
  // Fill today past Studio's daily runs, then one more is refused.
  await redisPipeline([["HSET", `nl:wf:day:${list}:${new Date(Date.now()).toISOString().slice(0, 10)}`, "started", 300]]);
  await upsertContact(list, "eve@example.com", { agreed: true, explicit: true, source: "free" }, ROOM);
  await enroll(store, "eve@example.com", { joined: false, tag: "lost" });
  is("counted before the ceiling", (today?.started ?? 0) > 0, true);
  is("past the ceiling nobody more starts today, and the refusal is counted", [(await readRun(lostId, personOf("eve@example.com"))) === null, (await runsToday(list))?.refused], [true, 1]);
  is("and their start is given back for another day", (await redisPipeline([["EXISTS", `nl:mail:enr:${lostId}:${personOf("eve@example.com")}`]]))[0], 0);

  // UTC day separation is checked explicitly, rather than by waiting for
  // the real clock to cross midnight while another assertion is running.
  const quotaDay = new Date(Date.now()).toISOString().slice(0, 10);
  const quotaMidnight = Date.parse(quotaDay + "T00:00:00Z") / 1000;
  is("the next UTC day has its own empty run counter",
    await runsToday(list, quotaMidnight + 86_400), { started: 0, refused: 0 });
  is("reading the next day does not reset the previous day's ceiling",
    await runsToday(list, quotaMidnight + 12 * 3_600), { started: 300, refused: 1 });

  part("Active workflows");
  const outcomes: string[] = [];
  for (let i = 0; i < 9; i += 1) {
    const made = await saveFlow(store, { name: `Extra ${i}`, trigger: "joined", steps: [{ delayHours: 0, subject: `Extra ${i}`, body: "x" }] });
    const extra = made.ok ? made.flows.find((f) => f.name === `Extra ${i}`) : undefined;
    const on = extra ? await setFlowActive(store, extra.id, true) : made;
    outcomes.push(on.ok ? "on" : on.reason);
  }
  is("Studio switches on ten at most; the eleventh is refused", [outcomes.filter((o) => o === "on").length, outcomes.at(-1)], [8, "active_limit"]);
  is("saving one switched on is refused the same way", (await saveFlow(store, { ...(await readFlows(list)).find((f) => !f.active)!, active: true } as unknown as Record<string, unknown>)), { ok: false, reason: "active_limit" });

  part("Erased: a person mid-run leaves nothing behind in any workflow");
  // Every key, and every value, that mentions an address or its key.
  const holding = (needle: string) => {
    const data = (redis as unknown as { data: Map<string, unknown> }).data;
    const text = (v: unknown): string => (v instanceof Map ? JSON.stringify([...v.entries()]) : v instanceof Set ? JSON.stringify([...v]) : JSON.stringify(v));
    // The in-memory double keeps an empty container after a read of a missing key; Redis keeps none.
    const empty = (v: unknown) => (v instanceof Map || v instanceof Set ? v.size === 0 : Array.isArray(v) && v.length === 0);
    return [...data.entries()].filter(([key, value]) => !empty(value) && (key.includes(needle) || text(value).includes(needle))).map(([key]) => key).sort();
  };
  const live = () => [...(redis as unknown as { data: Map<string, unknown> }).data.entries()].filter(([, v]) => !(v instanceof Map || v instanceof Set ? v.size === 0 : Array.isArray(v) && v.length === 0)).map(([k]) => k);
  // The contact's own row and its unsubscribe token belong to the list, not to the workflows.
  const listOwned = (key: string) => key === leadsKey(list) || key.startsWith("nl:mail:unsub:");
  // A new day's runs (the ceiling test above used today's).
  await redisPipeline([["DEL", `nl:wf:day:${list}:${new Date(Date.now()).toISOString().slice(0, 10)}`]]);
  await upsertContact(list, "fay@example.com", { agreed: true, explicit: true, source: "free" }, ROOM);
  const mid = await saveFlow(store, { name: "Mid", trigger: "tagged", tag: "mid", steps: [{ id: id(31), delayHours: 0, subject: "Mid one", body: "1" }, { id: id(32), delayHours: 48, subject: "Mid two", body: "2" }] });
  const midId = mid.ok ? mid.flows.find((f) => f.name === "Mid")!.id : "";
  await redisPipeline([["SET", `nl:mail:flows:${list}`, JSON.stringify((await readFlows(list)).map((f) => (f.id === midId ? { ...f, active: true } : { ...f, active: false })))]]);
  await enroll(store, "fay@example.com", { joined: false, tag: "mid" });
  await enroll(store, "fay@example.com", { joined: false, tag: "lost" });
  await run();
  const fay = personOf("fay@example.com");
  is("mid-run: her first email went, the second is waiting, and her run is recorded", [to("Mid one").includes("fay@example.com"), (await readRun(midId, fay))?.run.status], [true, "running"]);
  is("before erasure, workflow keys hold her address", holding("fay@example.com").filter((k) => !listOwned(k)).length > 0, true);
  is("erased from every workflow of the store", (await forgetWorkflowPerson(store, " Fay@Example.com ")).flows, (await readFlows(list)).length);
  is("afterward no key outside her list row holds her address", holding("fay@example.com").filter((k) => !listOwned(k)), []);
  is("nor her run key, start or held entry", holding(fay), []);
  await later(48);
  is("and her waiting step never goes out", to("Mid two"), []);

  part("Erased: a workflow removed, and a store deleted");
  await upsertContact(list, "gus@example.com", { agreed: true, explicit: true, source: "free" }, ROOM);
  await enroll(store, "gus@example.com", { joined: false, tag: "mid" });
  await run();
  is("a run is recorded for him", (await readRun(midId, personOf("gus@example.com")))?.run.status, "running");
  is("removing the workflow erases its runs", [(await removeFlow(store, midId)).ok, holding("gus@example.com").filter((k) => !listOwned(k)), holding(midId).filter((k) => k !== `nl:mail:flows:${list}`)], [true, [], []]);
  await forgetStoreWorkflows(store);
  is("deleting the store erases every workflow, run, start and hold", live().filter((k) => k.startsWith("nl:wf:run:") || k.startsWith("nl:wf:log:") || k.startsWith("nl:wf:runs:") || k.startsWith("nl:wf:held:") || k.startsWith("nl:mail:enr:") || k === `nl:mail:flows:${list}`), []);
  is("and no queued step of the store is left", ((await redisPipeline([["ZRANGEBYSCORE", "nl:mail:flowq", 0, "+inf"]]))[0] as string[]).filter((m) => m.startsWith(`${list}|`)), []);

  mail.restore();
  done();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
