/**
 * "Signed a proposal or an agreement" as a workflow trigger (635 [GL3];
 * added 2 November 2026), against the in-memory Redis double and synthetic
 * stores only: it starts the workflows that start on signing, once, only for
 * somebody on the list who agreed to hear from the creator; a plan without
 * workflows reads nothing; the route calls it with the address it was sent
 * to, and the studio offers it only on a plan with agreements.
 */
import { readFileSync } from "node:fs";
import { upsertContact } from "@/lib/contacts";
import { SIGNED_TRIGGER_UNITS, agreementSigned } from "@/lib/agreement-flow-trigger";
import { isMailable } from "@/lib/contacts";
import { RUN_START_COMMANDS } from "@/lib/flow-limits";
import { laterPageCost } from "./traffic-cost";
import { request } from "./plan-cost-registry";
import { FLOW_TRIGGERS } from "@/lib/flow-rules";
import { enroll, flowsStartedFor, readFlows, saveFlow, setFlowActive } from "@/lib/flows";
import { claimHandle, ensureListId, ensureStatsId, setMailSettings, setStripeAccount, setSubscription, storeForEmail } from "@/lib/store";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";
import { paidPeriod } from "./billing-period-fixture";
import { ROOM } from "./data-room";

globalThis.fetch = (async () => new Response(JSON.stringify({ object: "list", data: [], has_more: false }), { status: 200 })) as typeof fetch;

async function main(): Promise<void> {
  const OWNER = "signs@example.com";
  await claimHandle(OWNER, "signs", "Signs Studio", "");
  await ensureStatsId(OWNER);
  await ensureListId(OWNER);
  await setStripeAccount(OWNER, "acct_1TestSigns00001", true);
  await setSubscription(OWNER, { customerId: "cus_Signs0001", subscriptionId: "sub_Signs0001", active: true, tier: "pro", period: paidPeriod() });
  await setMailSettings(OWNER, { fromName: "Signs Studio", address: "1 Main St, Portland, OR 97201" });
  const store = (await storeForEmail(OWNER))!;
  const list = store.listId!;

  part("A workflow that starts on signing");
  is("a trigger of its own", FLOW_TRIGGERS.includes("signed"), true);
  const saved = await saveFlow(store, { name: "After signing", trigger: "signed", steps: [{ delayHours: 0, subject: "Welcome aboard", body: "Thank you for signing." }] });
  is("saved on a plan with agreements", saved.ok, true);
  const flowId = saved.ok ? saved.flows.find((f) => f.trigger === "signed")!.id : "";
  await setFlowActive(store, flowId, true);
  const flows = await readFlows(list);
  is("one workflow a store starts on signing; it can start others with a step", await saveFlow(store, { name: "Twice", trigger: "signed", steps: [{ delayHours: 0, subject: "a", body: "b" }] }), { ok: false, reason: "signed_taken" });

  part("Who it starts");
  await upsertContact(list, "ana@example.com", { agreed: true, explicit: true, source: "free" }, ROOM);
  is("someone on the list who agreed: started", [await agreementSigned(store, "ana@example.com"), await flowsStartedFor(flows, "ana@example.com")], ["checked", [flowId]]);
  is("signing again, another version or another agreement: started once", [await agreementSigned(store, "ana@example.com"), await flowsStartedFor(flows, "ana@example.com")], ["checked", [flowId]]);
  is("someone not on the list: nothing, and signing never puts them on it", [await agreementSigned(store, "ben@example.com"), await flowsStartedFor(flows, "ben@example.com"), await isMailable(list, "ben@example.com")], ["checked", [], false]);
  await upsertContact(list, "cy@example.com", { agreed: false, explicit: true, source: "free" }, ROOM);
  is("someone on the list who did not agree to hear from the creator: nothing", [await agreementSigned(store, "cy@example.com"), await flowsStartedFor(flows, "cy@example.com")], ["checked", []]);
  is("no address: nothing read", await agreementSigned(store, ""), "none");

  part("What it costs");
  const original = redis.pipeline;
  let commands = 0;
  try {
    redis.pipeline = async (c) => { commands += c.length; return original.call(redis, c); };
    is("a plan without workflows reads nothing", await agreementSigned({ ...store, tier: "creator" }, "ana@example.com"), "none");
  } finally { redis.pipeline = original; }
  is("not one command for it", commands, 0);
  await upsertContact(list, "dee@example.com", { agreed: true, explicit: true, source: "free" }, ROOM);
  commands = 0;
  try {
    redis.pipeline = async (c) => { commands += c.length; return original.call(redis, c); };
    await enroll(store, "dee@example.com", { joined: false, signed: true });
  } finally { redis.pipeline = original; }
  // The check and a start refused at the daily ceiling at the most; an admitted start is a run, priced as one (lib/flow-limits.ts).
  is(`the check, beside the run's own start, is ${commands} commands, inside a light request`, commands <= 20 + RUN_START_COMMANDS, true);
  is(`and ${SIGNED_TRIGGER_UNITS} public request, priced as a page, is above a light request of those commands`, laterPageCost() * SIGNED_TRIGGER_UNITS >= request("light", commands), true);

  part("The route and the studio");
  const route = readFileSync("app/api/store/agreement-sign/route.ts", "utf8");
  is("the route starts it after the signature is recorded, with the address it was sent to", route.indexOf("await agreementSigned(store, signed.agreement.email)") > route.indexOf("if (!signed.ok)"), true);
  const studio = readFileSync("components/email-studio.tsx", "utf8");
  is("the studio offers it only on a plan with agreements, and says what it does", [studio.includes('automation.signing || draft.trigger === "signed" ? <option value="signed">Someone who agreed to hear from you signs a proposal or agreement</option>'), studio.includes("Starts when someone who agreed to hear from you signs one of your proposals or agreements")], [true, true]);
  const privacy = readFileSync("app/privacy/page.tsx", "utf8").replace(/\s+/g, " ");
  is("the privacy policy says who it starts for, that signing never adds anyone to the list and that nothing new is kept", privacy.includes("An automatic email sequence may start when you sign a creator&apos;s proposal or agreement, for the address it was sent to; it starts only while you are on their list and agreed to hear from them, signing never adds you to the list, and nothing new is kept about you for it beyond the signature and the sequence&apos;s record."), true);
  is("the check takes the store's public requests first", readFileSync("lib/agreement-flow-trigger.ts", "utf8").includes('if (!(await takePublicRequest(store, "buyer", Date.now(), SIGNED_TRIGGER_UNITS))) {'), true);
}

void main().then(() => done(), (error) => {
  console.error(error);
  process.exit(1);
});
