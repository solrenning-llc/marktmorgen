/**
 * A workflow run's history: its effects counted four ways, kept apart, and
 * how much it can keep (lib/run-effects.ts, lib/flow-runs.ts; added 18
 * October 2026, ClickFunnels audit row F24). Checked against the in-memory
 * Redis and a stand-in for the email provider:
 *
 *   - an attempt with no outcome, and an uncertain step the creator marked as
 *     gone through, are counted uncertain, never confirmed;
 *   - a step that waits (the month's emails ran out) and is tried again
 *     writes nothing new to the run's history, so waiting cannot grow it
 *     past what the store's data room was charged for;
 *   - a creator's choice on a held run keeps its history within
 *     MAX_RUN_EVENTS, and the history says its earliest events were let go;
 *   - the bound on a workflow's runs follows from the plan's runs a day.
 */
import { DAILY_RUNS_BY_TIER, MAX_RETRIES_BY_YOU, MAX_RUNS_KEPT_PER_FLOW, MAX_RUN_EVENTS, MAX_STEPS, RUN_KEEP_SECONDS, TRIAL_DAILY_RUNS } from "@/lib/flow-limits";
import { KEPT_AFTER_CHOICE, personOf, readRun, type RunEvent } from "@/lib/flow-runs";
import { enroll, resolveHeldRun, saveFlow, sendDueSteps, setFlowActive } from "@/lib/flows";
import { runEffects } from "@/lib/run-effects";
import { upsertContact } from "@/lib/contacts";
import { claimHandle, ensureListId, ensureStatsId, setMailSettings, setStripeAccount, setSubscription, storeForEmail, storeForHandle } from "@/lib/store";
import { windowId } from "@/lib/allowance-window";
import { redisPipeline } from "@/lib/redis";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";
import { paidPeriod } from "./billing-period-fixture";
import { ROOM } from "./data-room";
import { installSesMailFixture } from "./ses-mail-fixture";

const realNow = Date.now;
let shift = 0;
Date.now = () => realNow() + shift;

const mail = installSesMailFixture({
  fallback: () => new Response(JSON.stringify({ object: "list", data: [], has_more: false })),
});
const sent = mail.sesAttempts;

const run = () => sendDueSteps((handle) => storeForHandle(handle), Date.now() + 20_000);
const ev = (step: number, state: RunEvent["state"], note = "", stepId = `s${step}`): RunEvent => ({ at: 1, step, stepId, kind: "email", state, note });

async function main(): Promise<void> {
  redis.clear();
  mail.configure();
  await mail.setReady(true, { max24: 50_000, rate: 100 });
  process.env.STRIPE_SECRET_KEY = "sk_test_workflows_only_a_stand_in";
  process.env.RESEND_API_KEY = "re_test_workflows_only_a_stand_in";

  part("Effects are counted four ways, and nothing unconfirmed counts as done");
  const mixed = runEffects([
    ev(-1, "started"),
    ev(0, "attempted"),
    ev(0, "confirmed", "Handed to the sender."),
    ev(1, "attempted"),
    ev(1, "failed", "The sender refused this email as it is."),
    ev(2, "attempted"),
    ev(2, "uncertain", "The sender's answer was lost."),
    { ...ev(2, "resolved", "Marked as done by you; going on to step 4."), kind: "run" },
    ev(3, "attempted"),
  ]);
  is("four attempts: one confirmed, one failed, two uncertain", mixed.counts, { attempted: 4, confirmed: 1, failed: 1, uncertain: 2 });
  is("the one marked as gone through by the creator stays uncertain, with their choice beside it", [mixed.markedByYou, mixed.effects[2].state, mixed.effects[2].choice], [1, "uncertain", "Marked as done by you; going on to step 4."]);
  is("an attempt with no outcome yet is uncertain and waiting, never done", [mixed.effects[3].state, mixed.effects[3].waiting], ["uncertain", true]);
  is("a full history is not trimmed", mixed.trimmed, false);
  const skipped = runEffects([ev(-1, "started"), ev(0, "skipped", "The condition did not hold."), ev(1, "attempted"), ev(1, "confirmed")]);
  is("a skipped step is not an effect", skipped.counts, { attempted: 1, confirmed: 1, failed: 0, uncertain: 0 });
  const retried = runEffects([ev(-1, "started"), ev(0, "attempted"), ev(0, "uncertain"), { ...ev(0, "resolved", "Tried again at your request."), kind: "run" }, ev(0, "attempted"), ev(0, "confirmed")]);
  is("a step tried again is two attempts: the first stays uncertain, the second is confirmed", [retried.counts, retried.markedByYou], [{ attempted: 2, confirmed: 1, failed: 0, uncertain: 1 }, 0]);
  const late = runEffects([ev(4, "confirmed"), ev(5, "attempted"), ev(5, "uncertain")]);
  is("a history whose earliest events were let go says so, and still counts the outcome it kept", [late.trimmed, late.counts], [true, { attempted: 2, confirmed: 1, failed: 0, uncertain: 1 }]);

  part("Bounds by construction");
  is("a workflow keeps at most the plan's runs a day for as long as a start is remembered", MAX_RUNS_KEPT_PER_FLOW, Math.max(...Object.values(DAILY_RUNS_BY_TIER), TRIAL_DAILY_RUNS) * (RUN_KEEP_SECONDS / 86_400));
  is("after a choice, there is room for everything a run can still write", KEPT_AFTER_CHOICE + 2 + 2 * MAX_STEPS, MAX_RUN_EVENTS);

  const OWNER = "rowan@example.com";
  await claimHandle(OWNER, "rowan", "Rowan Studio", "");
  await ensureStatsId(OWNER);
  await ensureListId(OWNER);
  await setStripeAccount(OWNER, "acct_1TestRowan00001", true);
  await setSubscription(OWNER, { customerId: "cus_Rowan0001", subscriptionId: "sub_Rowan0001", active: true, tier: "pro", period: paidPeriod() });
  await setMailSettings(OWNER, { fromName: "Rowan Studio", address: "1 Main St, Portland, OR 97201" });
  let store = (await storeForEmail(OWNER))!;
  const list = store.listId as string;
  const made = await saveFlow(store, { name: "Wait", trigger: "tagged", tag: "wait", steps: [{ id: "a000000000000001", delayHours: 0, subject: "Waited for", body: "Hello." }] });
  const flowId = made.ok ? made.flows.find((f) => f.name === "Wait")!.id : "";
  await setFlowActive(store, flowId, true);
  store = (await storeForEmail(OWNER))!;

  part("A step that waits writes nothing new");
  await upsertContact(list, "ivy@example.com", { agreed: true, explicit: true, source: "free" }, ROOM);
  await enroll(store, "ivy@example.com", { joined: false, tag: "wait" });
  const ivy = personOf("ivy@example.com");
  // The month's emails are used up when the step comes round.
  const used = () => `nl:mail:used:${list}:${windowId(store)}`;
  await redisPipeline([["SET", used(), 1_000_000_000]]);
  await run();
  const waiting = await readRun(flowId, ivy);
  is("it waits: nothing was sent", [waiting?.run.status, sent.some((message) => message.subject === "Waited for")], ["waiting", false]);
  is("and its history is still just its start", waiting?.events.map((e) => e.state), ["started"]);
  // Tried again when it is due (lib/flow-retry.ts: when the month turns), with room this time.
  const [flat] = await redisPipeline([["ZRANGEBYSCORE", "nl:mail:flowq", 0, "+inf", "WITHSCORES"]]);
  const due = Number((flat as string[])[(flat as string[]).findIndex((m) => m.endsWith("|ivy@example.com")) + 1]);
  shift += (due - Math.floor(Date.now() / 1000) + 1) * 1000;
  await redisPipeline([["DEL", used()]]);
  await run();
  const through = await readRun(flowId, ivy);
  is("once there is room it goes out, written down once: attempted, then confirmed", [sent.filter((message) => message.subject === "Waited for").length, through?.events.map((e) => e.state)], [1, ["started", "attempted", "confirmed"]]);
  is("counted as one attempt, confirmed", runEffects(through?.events ?? []).counts, { attempted: 1, confirmed: 1, failed: 0, uncertain: 0 });

  part("A held run's history stays bounded, whatever came before the creator's choice");
  await upsertContact(list, "jo@example.com", { agreed: true, explicit: true, source: "free" }, ROOM);
  await enroll(store, "jo@example.com", { joined: false, tag: "wait" });
  const jo = personOf("jo@example.com");
  mail.setSesOutcome("lost");
  await run();
  is("a lost answer holds the run", (await readRun(flowId, jo))?.run.status, "held");
  is(`trying it again is taken ${MAX_RETRIES_BY_YOU} time${MAX_RETRIES_BY_YOU === 1 ? "" : "s"}, then refused`, [await resolveHeldRun(store, flowId, jo, "retry"), (await run(), await resolveHeldRun(store, flowId, jo, "retry"))], ["ok", "retry_limit"]);
  mail.setSesOutcome("ok");
  // As if a history had grown long before these bounds existed: a choice still leaves it within MAX_RUN_EVENTS.
  const log = `nl:wf:log:${flowId}:${jo}`;
  await redisPipeline([["RPUSH", log, ...Array.from({ length: 80 }, (_, i) => JSON.stringify({ at: i, step: 0, stepId: "a000000000000001", kind: "email", state: "skipped", note: "" }))]]);
  is("going on past it is the creator's word", await resolveHeldRun(store, flowId, jo, "continue"), "ok");
  const kept = (await readRun(flowId, jo))?.events ?? [];
  is(`the choice keeps the latest ${KEPT_AFTER_CHOICE} events, room for all that can follow`, kept.length, KEPT_AFTER_CHOICE);
  const counted = runEffects(kept);
  is("the history says its earliest events were let go", counted.trimmed, true);
  is("its last event is the creator's choice, and nothing it kept counts as confirmed", [kept.at(-1)?.state, counted.counts.confirmed], ["resolved", 0]);

  mail.restore();
  done();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
