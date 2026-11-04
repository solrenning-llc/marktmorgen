/**
 * "Paid a payment request" as a workflow trigger (635 [GL3]; added
 * 2 November 2026), against the in-memory Redis double and synthetic stores
 * only: the first time a request is written down as paid, the store's one
 * workflow that starts on it starts for the person it was sent to, only while
 * on the list and agreed to hear from the creator, once; a second write
 * starts nothing; a plan without workflows reads nothing.
 */
import { readFileSync } from "node:fs";
import { PAID_TRIGGER_UNITS, paymentRequestPaid } from "@/lib/payment-flow-trigger";
import { isMailable, upsertContact } from "@/lib/contacts";
import { RUN_START_COMMANDS } from "@/lib/flow-limits";
import { FLOW_TRIGGERS } from "@/lib/flow-rules";
import { enroll, flowsStartedFor, readFlows, saveFlow, setFlowActive } from "@/lib/flows";
import { createRequest, markPaid } from "@/lib/payment-request-store";
import { readDraft } from "@/lib/payment-request-rules";
import { claimHandle, ensureListId, ensureStatsId, setMailSettings, setStripeAccount, setSubscription, storeForEmail } from "@/lib/store";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";
import { paidPeriod } from "./billing-period-fixture";
import { ROOM } from "./data-room";
import { laterPageCost } from "./traffic-cost";
import { request } from "./plan-cost-registry";

globalThis.fetch = (async () => new Response(JSON.stringify({ object: "list", data: [], has_more: false }), { status: 200 })) as typeof fetch;

const LINE = { text: "Coaching, October", quantity: 1, amount: "480" };
const draftFor = (email: string) => (readDraft({ email, name: "Client", lines: [LINE], note: "", dueDate: "", autoReminders: 0, consent: true }, "usd", Date.now()) as { ok: true; draft: Parameters<typeof createRequest>[1] }).draft;

async function main(): Promise<void> {
  const OWNER = "pays@example.com";
  await claimHandle(OWNER, "pays", "Pays Studio", "");
  await ensureStatsId(OWNER);
  await ensureListId(OWNER);
  await setStripeAccount(OWNER, "acct_1TestPays000001", true);
  await setSubscription(OWNER, { customerId: "cus_Pays00001", subscriptionId: "sub_Pays00001", active: true, tier: "pro", period: paidPeriod() });
  await setMailSettings(OWNER, { fromName: "Pays Studio", address: "1 Main St, Portland, OR 97201" });
  const store = (await storeForEmail(OWNER))!;
  const list = store.listId!;

  part("A workflow that starts on a paid request");
  is("a trigger of its own", FLOW_TRIGGERS.includes("paid_request"), true);
  const saved = await saveFlow(store, { name: "After paying", trigger: "paid_request", steps: [{ delayHours: 0, subject: "Thank you", body: "Here is what comes next." }] });
  const flowId = saved.ok ? saved.flows.find((f) => f.trigger === "paid_request")!.id : "";
  await setFlowActive(store, flowId, true);
  const flows = await readFlows(list);
  is("one workflow a store; it can start others with a step", await saveFlow(store, { name: "Twice", trigger: "paid_request", steps: [{ delayHours: 0, subject: "a", body: "b" }] }), { ok: false, reason: "paid_request_taken" });

  part("Who it starts, from the payment written down");
  await upsertContact(list, "ana@example.com", { agreed: true, explicit: true, source: "free" }, ROOM);
  const forAna = await createRequest(store, draftFor("ana@example.com"));
  const anaId = forAna.ok ? forAna.request.id : "";
  const first = await markPaid(store, anaId, { id: "cs_test_ana_1", amount_total: 48_000 });
  is("the first time it is paid: written down, and started for the person it was sent to", [first?.fresh, await flowsStartedFor(flows, "ana@example.com")], [true, [flowId]]);
  const again = await markPaid(store, anaId, { id: "cs_test_ana_2", amount_total: 48_000 });
  is("written down again (the page after paying and the five-minute job both): not fresh, so nothing is checked", [again?.fresh, await flowsStartedFor(flows, "ana@example.com")], [false, [flowId]]);
  const forBen = await createRequest(store, draftFor("ben@example.com"));
  await markPaid(store, forBen.ok ? forBen.request.id : "", { id: "cs_test_ben", amount_total: 48_000 });
  is("someone not on the list: nothing, and paying never puts them on it", [await flowsStartedFor(flows, "ben@example.com"), await isMailable(list, "ben@example.com")], [[], false]);
  await upsertContact(list, "cy@example.com", { agreed: false, explicit: true, source: "free" }, ROOM);
  const forCy = await createRequest(store, draftFor("cy@example.com"));
  await markPaid(store, forCy.ok ? forCy.request.id : "", { id: "cs_test_cy", amount_total: 48_000 });
  is("someone on the list who did not agree to hear from the creator: nothing", await flowsStartedFor(flows, "cy@example.com"), []);
  const anaAgain = await createRequest(store, draftFor("ana@example.com"));
  is("the same person paying a second request: started once, still", [(await markPaid(store, anaAgain.ok ? anaAgain.request.id : "", { id: "cs_test_ana_3", amount_total: 48_000 }))?.fresh, await flowsStartedFor(flows, "ana@example.com")], [true, [flowId]]);

  part("What it costs");
  const original = redis.pipeline;
  let commands = 0;
  try {
    redis.pipeline = async (c) => { commands += c.length; return original.call(redis, c); };
    is("a plan without workflows reads nothing", await paymentRequestPaid({ ...store, tier: "creator" }, "ana@example.com"), "none");
  } finally { redis.pipeline = original; }
  is("not one command for it", commands, 0);
  await upsertContact(list, "eve@example.com", { agreed: true, explicit: true, source: "free" }, ROOM);
  commands = 0;
  try {
    redis.pipeline = async (c) => { commands += c.length; return original.call(redis, c); };
    await enroll(store, "eve@example.com", { joined: false, paidRequest: true });
  } finally { redis.pipeline = original; }
  is(`the check, beside the run's own start, is ${commands} commands, inside a light request`, commands <= 20 + RUN_START_COMMANDS, true);
  is(`and ${PAID_TRIGGER_UNITS} public request, priced as a page, is above a light request of those commands`, laterPageCost() * PAID_TRIGGER_UNITS >= request("light", commands), true);
  is("no address: nothing read", await paymentRequestPaid(store, ""), "none");

  part("The studio and the payment path");
  const studio = readFileSync("components/email-studio.tsx", "utf8");
  is("offered only where payment requests can be taken now, and said in words", [studio.includes('automation.requests || draft.trigger === "paid_request" ? <option value="paid_request">Someone who agreed to hear from you pays one of your payment requests</option>'), readFileSync("app/studio/email/page.tsx", "utf8").includes("requests: requestsOpen(store),")], [true, true]);
  const paths = readFileSync("lib/payment-request-store.ts", "utf8");
  is("the payment path loads the workflows only when a payment is first written, never at the top", [paths.includes('await import("@/lib/payment-flow-trigger")'), /^import .*payment-flow-trigger/m.test(paths)], [true, false]);
}

void main().then(() => done(), (error) => {
  console.error(error);
  process.exit(1);
});
