/**
 * Several pipelines, and "a deal entered a stage" as a workflow trigger
 * (added 17 October 2026, HighLevel audit H02 and H18's stage trigger).
 * Checked against the in-memory Redis double, a stand-in email provider and
 * synthetic stores only:
 *
 *   - the rules: strict pipelines (no stage id in two, no name twice, every
 *     stage kept), the plan's number, the last pipeline kept, a stage with
 *     deals never removed without a chosen stage, honest totals;
 *   - the board a store had becomes the first pipeline with no write and no
 *     deal changed, and its old key keeps a copy of the first pipeline;
 *   - a deal moves between pipelines and keeps every other field; a stage
 *     or a pipeline removed moves its deals where the creator said, and a
 *     refusal writes nothing; a concurrent change is never overwritten;
 *   - the route enforces the plan's number of pipelines and the moves;
 *   - a deal made in or moved to a stage starts that stage's one workflow,
 *     once, only for somebody on the list, and the check takes one studio
 *     request; removal moves start nothing; one workflow a stage;
 *   - the check stays inside the studio request it takes.
 */
import { NextRequest } from "next/server";
import { POST } from "@/app/api/store/crm/route";
import { SESSION_COOKIE, openSession } from "@/lib/auth";
import { upsertContact } from "@/lib/contacts";
import { CrmSchemaConflict, readDeal, readDeals, readOpportunityReview, readPipelines, readStages, savePipelineChange, writeDeal } from "@/lib/crm";
import {
  DEFAULT_STAGES,
  FIRST_PIPELINE_ID,
  MAX_PIPELINES,
  MAX_STAGES,
  PIPELINES_BY_TIER,
  TRIAL_PIPELINES,
  UNPAID_PIPELINES,
  type Deal,
  type Pipeline,
  changePipeline,
  labeledStages,
  parsePipelines,
  pipelineLimit,
  pipelineTotals,
  stageLabel,
  starterStages,
} from "@/lib/crm-rules";
import { STAGE_TRIGGER_UNITS, dealEnteredStage, entersStage } from "@/lib/deal-stage-trigger";
import { flowConfigurationIssues } from "@/lib/flow-review";
import { RUN_START_COMMANDS } from "@/lib/flow-limits";
import { allowanceUsed } from "@/lib/store-allowance";
import { enroll, flowsStartedFor, readFlows, saveFlow, setFlowActive } from "@/lib/flows";
import { claimHandle, ensureListId, ensureStatsId, setMailSettings, setStripeAccount, setSubscription, storeForEmail } from "@/lib/store";
import { UNIT_COST, request } from "./plan-cost-registry";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";
import { paidPeriod } from "./billing-period-fixture";
import { ROOM } from "./data-room";
import { dataKey } from "@/lib/store-data";
import { dataBytes } from "@/lib/store-data-rules";

globalThis.fetch = (async () => new Response(JSON.stringify({ object: "list", data: [], has_more: false }), { status: 200 })) as typeof fetch;

const coaching: Pipeline = { id: "coach0", name: "Coaching", stages: [{ id: "cnew00", name: "New", kind: "open" }, { id: "ccall0", name: "Call booked", kind: "open" }, { id: "cwon00", name: "Won", kind: "won" }, { id: "clost0", name: "Lost", kind: "lost" }] };
const sales: Pipeline = { id: FIRST_PIPELINE_ID, name: "Sales", stages: DEFAULT_STAGES };
const deal = (id: string, stage: string, extra: Partial<Deal> & Record<string, unknown> = {}): Deal => ({ id, title: "Deal " + id, email: "", cents: 1000, stage, note: "", createdAt: 100, updatedAt: 200, ...extra });

async function main(): Promise<void> {
  redis.clear();
  process.env.UPSTASH_REDIS_REST_URL ??= "http://stub";
  process.env.STRIPE_SECRET_KEY = "sk_test_pipelines_only_a_stand_in";
  process.env.RESEND_API_KEY = "re_test_pipelines_only_a_stand_in";

  part("Pipelines are read strictly");
  is("two valid pipelines", parsePipelines([sales, coaching])?.length, 2);
  is("a stage id in two pipelines is refused", parsePipelines([sales, { ...coaching, stages: [...coaching.stages.slice(0, 3), { id: "lead00", name: "Lost", kind: "lost" }] }]), null);
  is("a name twice is refused, whatever its case", parsePipelines([sales, { ...coaching, name: "SALES" }]), null);
  is("a pipeline without a won stage is refused", parsePipelines([{ ...coaching, stages: coaching.stages.filter((s) => s.kind !== "won") }]), null);
  is("a stage that cannot be read refuses the whole pipeline (no stage silently dropped)", parsePipelines([{ ...coaching, stages: [...coaching.stages, { id: "BAD", name: "x", kind: "open" }] }]), null);
  is(`more than ${MAX_STAGES} stages are refused`, parsePipelines([{ ...coaching, stages: [...coaching.stages, ...Array.from({ length: MAX_STAGES }, (_, i) => ({ id: "extra" + i, name: "Extra " + i, kind: "open" as const }))] }]), null);
  let n = 0;
  const many = Array.from({ length: MAX_PIPELINES + 1 }, (_, i) => ({ id: "p" + String(i).padStart(5, "0"), name: "P" + i, stages: starterStages(() => "s" + String(n++).padStart(5, "0")) }));
  is(`${MAX_PIPELINES} pipelines are kept`, parsePipelines(many.slice(0, MAX_PIPELINES))?.length, MAX_PIPELINES);
  is(`more than ${MAX_PIPELINES} pipelines are refused`, parsePipelines(many), null);
  is("no pipeline at all is refused", parsePipelines([]), null);

  part("The plan's number of pipelines");
  const now = 1_800_000_000;
  is("by plan, the trial and no plan", [
    pipelineLimit({ tier: "creator", subscriptionActive: true, trialEnds: 0 }, now),
    pipelineLimit({ tier: "pro", subscriptionActive: true, trialEnds: 0 }, now),
    pipelineLimit({ tier: "scale", subscriptionActive: true, trialEnds: 0 }, now),
    pipelineLimit({ tier: "scale", subscriptionActive: true, trialEnds: now + 10 }, now),
    pipelineLimit({ tier: "scale", subscriptionActive: false, trialEnds: 0 }, now),
  ], [PIPELINES_BY_TIER.creator, PIPELINES_BY_TIER.pro, PIPELINES_BY_TIER.scale, TRIAL_PIPELINES, UNPAID_PIPELINES]);
  is("never above the stored ceiling", Math.max(...Object.values(PIPELINES_BY_TIER), TRIAL_PIPELINES) <= MAX_PIPELINES, true);

  part("A change to a pipeline, checked whole");
  const counts = new Map([["talk00", 2], ["ccall0", 1]]);
  is("a new pipeline past the plan's number is refused", changePipeline([sales], { pipeline: coaching }, {}, counts, 1), { ok: false, error: "pipeline_limit" });
  is("an existing one is edited at the limit", changePipeline([sales, coaching], { pipeline: { ...coaching, name: "1:1 coaching" } }, {}, counts, 1).ok, true);
  is("the last pipeline is kept", changePipeline([sales], { remove: FIRST_PIPELINE_ID }, "", counts, 5), { ok: false, error: "pipeline_last" });
  const dropTalking = { ...sales, stages: sales.stages.filter((s) => s.id !== "talk00") };
  is("a stage removed with deals needs a stage for them", changePipeline([sales, coaching], { pipeline: dropTalking }, {}, counts, 5), { ok: false, error: "moves" });
  is("and never one being removed", changePipeline([sales, coaching], { pipeline: dropTalking }, { talk00: "talk00" }, counts, 5), { ok: false, error: "moves" });
  is("an inherited name is not a choice", changePipeline([sales, coaching], { pipeline: dropTalking }, Object.create({ talk00: "lead00" }), counts, 5), { ok: false, error: "moves" });
  is("with a stage kept, in this pipeline or another", [changePipeline([sales, coaching], { pipeline: dropTalking }, { talk00: "lead00" }, counts, 5), changePipeline([sales, coaching], { pipeline: dropTalking }, { talk00: "cnew00" }, counts, 5).ok], [{ ok: true, pipelines: [dropTalking, coaching], moves: { talk00: "lead00" } }, true]);
  is("an empty stage goes without a choice", changePipeline([sales, coaching], { pipeline: { ...sales, stages: sales.stages.filter((s) => s.id !== "offr00") } }, {}, counts, 5).ok, true);
  is("a pipeline removed with deals sends them all to one stage of another", changePipeline([sales, coaching], { remove: "coach0" }, "lead00", counts, 5), { ok: true, pipelines: [sales], moves: { ccall0: "lead00" } });
  is("not to one of its own", changePipeline([sales, coaching], { remove: "coach0" }, "cnew00", counts, 5), { ok: false, error: "moves" });

  part("Totals are what the recorded values add up to");
  const totals = pipelineTotals(coaching, [deal("a000000001", "cnew00", { cents: 150000 }), deal("a000000002", "ccall0", { cents: 50000 }), deal("a000000003", "cwon00", { cents: 90000 }), deal("a000000004", "clost0", { cents: 7000 }), deal("a000000005", "lead00", { cents: 999999 })]);
  is("open, won and lost; another pipeline's deal left out", [totals.deals, totals.open, totals.won, totals.lost], [4, { count: 2, cents: 200000 }, { count: 1, cents: 90000 }, { count: 1, cents: 7000 }]);
  is("a stage named with its pipeline once there are two", [stageLabel([sales], DEFAULT_STAGES[0]), stageLabel([sales, coaching], coaching.stages[1]), labeledStages([sales, coaching]).length], ["New", "Coaching: Call booked", DEFAULT_STAGES.length + coaching.stages.length]);

  part("The board a store had is its first pipeline, untouched");
  const OWNER = "pipes@example.com";
  await claimHandle(OWNER, "pipes", "Pipes Studio", "");
  await ensureStatsId(OWNER);
  await ensureListId(OWNER);
  let store = (await storeForEmail(OWNER))!;
  const statsId = store.statsId!;
  const custom = [...DEFAULT_STAGES.slice(0, 2), { id: "cust00", name: "Proposal", kind: "open" as const }, ...DEFAULT_STAGES.slice(3)];
  const old = deal("b000000001", "cust00", { email: "dana@example.com", note: "Keep this", futureMetadata: { source: "manual" } });
  const oldRaw = JSON.stringify(old);
  await redis.pipeline([["SET", "nl:crm:stages:" + statsId, JSON.stringify(custom)], ["HSET", "nl:crm:deals:" + statsId, old.id, oldRaw]]);
  is("one pipeline, Sales, with the board's own stages", await readPipelines(statsId), [{ id: FIRST_PIPELINE_ID, name: "Sales", stages: custom }]);
  is("its deals read as before", (await readDeals(statsId, await readStages(statsId))).map((d) => [d.id, d.stage]), [[old.id, "cust00"]]);
  const review = await readOpportunityReview(statsId);
  is("the opportunity review agrees", [review.available, review.pipelines.length, review.stages.length], [true, 1, custom.length]);
  is("reading wrote nothing", (await redis.pipeline([["EXISTS", "nl:crm:pipes:" + statsId]]))[0], 0);

  const second: Pipeline = { ...coaching };
  const added = await savePipelineChange(statsId, { pipeline: second }, {}, 2, ROOM);
  is("a second pipeline is added", added.ok && added.pipelines.map((p) => p.id), [FIRST_PIPELINE_ID, "coach0"]);
  is("the first keeps the stages it had", (await readPipelines(statsId))[0].stages, custom);
  is("the existing deal is byte for byte unchanged", (await redis.pipeline([["HGET", "nl:crm:deals:" + statsId, old.id]]))[0], oldRaw);
  is("the board's old key keeps a copy of the first pipeline", JSON.parse(String((await redis.pipeline([["GET", "nl:crm:stages:" + statsId]]))[0])), custom);
  is("past the plan's number, refused and nothing written", [await savePipelineChange(statsId, { pipeline: { id: "third0", name: "Brand deals", stages: starterStages() } }, {}, 2, ROOM), (await readPipelines(statsId)).length], [{ ok: false, error: "pipeline_limit" }, 2]);

  part("A deal moves between pipelines and keeps everything else");
  const moved = { ...old, stage: "ccall0" };
  await writeDeal(statsId, moved, ROOM);
  is("now in Coaching", (await readDeal(statsId, old.id, await readStages(statsId)))?.stage, "ccall0");
  is("and its other fields, unknown ones too, are kept", JSON.parse(String((await redis.pipeline([["HGET", "nl:crm:deals:" + statsId, old.id]]))[0])).futureMetadata, { source: "manual" });

  part("A stage removed moves its deals where the creator said; a refusal writes nothing");
  const before = (await redis.pipeline([["GET", "nl:crm:pipes:" + statsId]]))[0];
  const withoutCall = { ...coaching, stages: coaching.stages.filter((s) => s.id !== "ccall0") };
  is("without a choice: refused", await savePipelineChange(statsId, { pipeline: withoutCall }, {}, 2, ROOM), { ok: false, error: "moves" });
  is("nothing written", [(await redis.pipeline([["GET", "nl:crm:pipes:" + statsId]]))[0] === before, (await readDeal(statsId, old.id, await readStages(statsId)))?.stage], [true, "ccall0"]);
  is("with a choice: saved", (await savePipelineChange(statsId, { pipeline: withoutCall }, { ccall0: "cust00" }, 2, ROOM)).ok, true);
  const back = JSON.parse(String((await redis.pipeline([["HGET", "nl:crm:deals:" + statsId, old.id]]))[0]));
  is("the deal went to the chosen stage, in the other pipeline, with every field kept", back, { ...old, stage: "cust00" });

  part("A concurrent change is never overwritten");
  const original = redis.pipeline;
  const afterSave: string[] = [];
  let saving = false;
  try {
    redis.pipeline = async (commands) => {
      if (saving) for (const c of commands) afterSave.push(`${c[0]} ${String(c[1])}`);
      if (commands.some((c) => c[0] === "EVAL" && String(c[1]).includes("crm-pipelines-save"))) {
        await original.call(redis, [["SET", "nl:crm:pipes:" + statsId, JSON.stringify([sales, coaching])]]);
        saving = true;
      }
      return original.call(redis, commands);
    };
    let conflict = false;
    try { await savePipelineChange(statsId, { pipeline: { ...coaching, name: "Mine" } }, {}, 2, ROOM); } catch (error) { conflict = error instanceof CrmSchemaConflict; }
    is("the change meanwhile is a conflict", conflict, true);
  } finally { redis.pipeline = original; }
  // The script that refused the write says how long the record there now is: the room is sized from that, with no
  // second read that could fail in between.
  const pipesNow = String((await redis.pipeline([["GET", "nl:crm:pipes:" + statsId]]))[0]);
  is(
    "its room is what the other session's record weighs, sized without reading it again",
    [afterSave.some((c) => c === "GET nl:crm:pipes:" + statsId), Number((await redis.pipeline([["HGET", dataKey(ROOM)!, "crm:pipes"]]))[0])],
    [false, dataBytes([pipesNow], 1)],
  );
  is("and the other session's pipelines are what is saved", (await readPipelines(statsId)).map((p) => p.name), ["Sales", "Coaching"]);

  part("The route: the plan's number, the moves, and removal");
  const session = await openSession(OWNER);
  const call = async (body: Record<string, unknown>) => {
    const response = await POST(new NextRequest("https://marktmorgen.com/api/store/crm", { method: "POST", headers: { "content-type": "application/json", cookie: SESSION_COOKIE + "=" + session }, body: JSON.stringify(body) }));
    return { status: response.status, body: await response.json() };
  };
  is("a store with no plan keeps one: a third is refused", (await call({ action: "pipeline", pipeline: { id: "third0", name: "Brand deals", stages: starterStages() } })).body, { ok: false, error: "pipeline_limit" });
  await setStripeAccount(OWNER, "acct_1TestPipes00001", true);
  await setSubscription(OWNER, { customerId: "cus_Pipes0001", subscriptionId: "sub_Pipes0001", active: true, tier: "pro", period: paidPeriod() });
  await setMailSettings(OWNER, { fromName: "Pipes Studio", address: "1 Main St, Portland, OR 97201" });
  store = (await storeForEmail(OWNER))!;
  const third = await call({ action: "pipeline", pipeline: { id: "third0", name: "Brand deals", stages: [{ id: "bnew00", name: "Pitched", kind: "open" }, { id: "bwon00", name: "Signed", kind: "won" }, { id: "blost0", name: "Passed", kind: "lost" }] } });
  is("on Studio a third is added", [third.status, third.body.pipelines?.length], [200, 3]);
  const inCoaching = await call({ action: "deal", deal: { title: "Six sessions", email: "", cents: 120000, stage: "cnew00" } });
  is("a removal with deals and no stage is refused", (await call({ action: "unpipeline", id: "coach0" })).body, { ok: false, error: "moves" });
  is("or to one of its own stages", (await call({ action: "unpipeline", id: "coach0", moveTo: "cnew00" })).body, { ok: false, error: "moves" });
  const removed = await call({ action: "unpipeline", id: "coach0", moveTo: "bnew00" });
  is("removed, its deal moved", [removed.status, removed.body.moved, (await readDeal(statsId, inCoaching.body.deal.id, await readStages(statsId)))?.stage], [200, 1, "bnew00"]);
  is("an unknown pipeline", (await call({ action: "unpipeline", id: "nope00", moveTo: "bnew00" })).status, 404);
  is("a malformed one", (await call({ action: "pipeline", pipeline: { id: "newp00", name: "", stages: starterStages() } })).body, { ok: false, error: "pipelines" });

  part("A deal entering a stage starts that stage's one workflow");
  const list = store.listId!;
  await upsertContact(list, "ana@example.com", { agreed: true, explicit: true, source: "free" }, ROOM);
  const flow = await saveFlow(store, { name: "Signed: welcome", trigger: "stage", stageId: "bwon00", steps: [{ delayHours: 0, subject: "Welcome aboard", body: "Glad to work with you." }] });
  is("a workflow can start from a stage", flow.ok, true);
  const flowId = flow.ok ? flow.flows.find((f) => f.trigger === "stage")!.id : "";
  is("its stage is kept", (await readFlows(list)).find((f) => f.id === flowId)?.stageId, "bwon00");
  is("one workflow a stage", await saveFlow(store, { name: "Twice", trigger: "stage", stageId: "bwon00", steps: [{ delayHours: 0, subject: "a", body: "b" }] }), { ok: false, reason: "stage_taken" });
  is("a stage the store does not have", await saveFlow(store, { name: "Nowhere", trigger: "stage", stageId: "nope00", steps: [{ delayHours: 0, subject: "a", body: "b" }] }), { ok: false, reason: "stage" });
  await setFlowActive(store, flowId, true);
  const flows = await readFlows(list);
  is("a deal with nobody named, or the same stage, is not an entry", [entersStage({ email: "", stage: "bwon00" }, null), entersStage({ email: "a@b.co", stage: "bwon00" }, { stage: "bwon00" }), entersStage({ email: "a@b.co", stage: "bwon00" }, { stage: "bnew00" }), entersStage({ email: "a@b.co", stage: "bwon00" }, null)], [false, false, true, true]);
  const anaDeal = await call({ action: "deal", deal: { title: "Brand deal with Ana", email: "ana@example.com", cents: 50000, stage: "bnew00" } });
  is("made in another stage: not started", [anaDeal.body.workflows, await flowsStartedFor(flows, "ana@example.com")], ["checked", []]);
  const signed = await call({ action: "deal", deal: { ...anaDeal.body.deal, stage: "bwon00" } });
  is("moved into the stage: started", [signed.body.workflows, await flowsStartedFor(flows, "ana@example.com")], ["checked", [flowId]]);
  await call({ action: "deal", deal: { ...signed.body.deal, stage: "bnew00" } });
  await call({ action: "deal", deal: { ...signed.body.deal, stage: "bwon00" } });
  is("moved out and in again: one run, as every trigger", Number((await redis.pipeline([["HGET", "nl:mail:flowstats:" + flowId, "started"]]))[0]), 1);
  const ben = await call({ action: "deal", deal: { title: "Ben, not on the list", email: "ben@example.com", cents: 0, stage: "bwon00" } });
  is("somebody not on the list starts nothing", [ben.body.workflows, await flowsStartedFor(flows, "ben@example.com")], ["checked", []]);
  await upsertContact(list, "cy@example.com", { agreed: true, explicit: true, source: "free" }, ROOM);
  const cy = await call({ action: "deal", deal: { title: "Cy", email: "cy@example.com", cents: 0, stage: "bnew00" } });
  await call({ action: "unpipeline", id: "third0", moveTo: "lead00" });
  is("a removal moves deals and starts nothing", [(await readDeal(statsId, cy.body.deal.id, await readStages(statsId)))?.stage, await flowsStartedFor(flows, "cy@example.com")], ["lead00", []]);
  is("a workflow whose stage was removed says so", flowConfigurationIssues((await readFlows(list)).find((f) => f.id === flowId)!, { products: [], courses: [], forms: [], fields: [], stages: await readStages(statsId), flows: [] }).some((i) => i.includes("no longer in your pipelines")), true);

  part("The check costs one studio request, and stays inside it");
  store = (await storeForEmail(OWNER))!;
  const usedBefore = await allowanceUsed(store, "studio");
  await call({ action: "deal", deal: { title: "No one named", email: "", cents: 0, stage: "lead00" } });
  const plain = (await allowanceUsed(store, "studio")) - usedBefore;
  await upsertContact(list, "eve@example.com", { agreed: true, explicit: true, source: "free" }, ROOM);
  await call({ action: "deal", deal: { title: "Eve", email: "eve@example.com", cents: 0, stage: "lead00" } });
  is("a deal entering a stage with somebody named takes one more", (await allowanceUsed(store, "studio")) - usedBefore - plain, plain + STAGE_TRIGGER_UNITS);
  const flow2 = await saveFlow(store, { name: "Lead: hello", trigger: "stage", stageId: "lead00", steps: [{ delayHours: 0, subject: "Hello", body: "Hi." }] });
  const lead = flow2.ok ? flow2.flows.find((f) => f.stageId === "lead00")!.id : "";
  await setFlowActive(store, lead, true);
  await upsertContact(list, "dee@example.com", { agreed: true, explicit: true, source: "free" }, ROOM);
  let commands = 0;
  try {
    redis.pipeline = async (c) => { commands += c.length; return original.call(redis, c); };
    await enroll(store, "dee@example.com", { joined: false, stage: "lead00" });
  } finally { redis.pipeline = original; }
  // The check and a start refused at the daily ceiling at the most; an admitted start is a run, priced as one (lib/flow-limits.ts).
  is(`the check fits inside the ${STAGE_TRIGGER_UNITS} studio request it takes, beside the run's own start (${commands} commands)`, commands <= 20 + RUN_START_COMMANDS, true);
  is("and one studio request is priced above a light request of those commands", UNIT_COST.studio * STAGE_TRIGGER_UNITS >= request("light", commands), true);
  is("a plan without workflows checks nothing and takes nothing", await dealEnteredStage({ ...store, tier: "creator" }, { email: "dee@example.com", stage: "lead00" }, null), "none");
  done();
}

void main();
