/**
 * A workflow step that needs the store's CRM schema, when that read answers in
 * an unknown shape once (CX-123 rules 24 and 30; Claude 6 on #2901). Nothing
 * was written, so the step waits and is tried again, as a deals board that
 * could not be read already does: never "uncertain", which holds the run
 * until the creator acts, and never "the field was removed".
 *
 *   - a field step whose fields read (readFields) is unknown;
 *   - a deal step whose pipelines read (readPipelines) is unknown.
 *
 * Synthetic store, contacts and mail stand-in only.
 */
import { enroll, saveFlow, sendDueSteps } from "@/lib/flows";
import { personOf, readRun } from "@/lib/flow-runs";
import { upsertContact } from "@/lib/contacts";
import { readDeals, readStages, readValues, writeFields } from "@/lib/crm";
import { writeForm } from "@/lib/form-store";
import { parseForm } from "@/lib/forms";
import { personKey } from "@/lib/person-key";
import { claimHandle, ensureListId, ensureStatsId, setMailSettings, setStripeAccount, setSubscription, storeForEmail, storeForHandle } from "@/lib/store";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";
import { paidPeriod } from "./billing-period-fixture";
import { ROOM } from "./data-room";
import { installSesMailFixture } from "./ses-mail-fixture";

const mail = installSesMailFixture({ fallback: () => new Response(JSON.stringify({ object: "list", data: [], has_more: false })) });
const run = () => sendDueSteps((handle) => storeForHandle(handle), Date.now() + 20_000);

/** The first pipeline matching `matches` answers `fault`; every other is answered truthfully. */
async function onceUnknown(matches: (commands: (string | number)[][]) => boolean, fault: unknown, work: () => Promise<unknown>): Promise<number> {
  const real = redis.pipeline.bind(redis);
  let hits = 0;
  (redis as unknown as { pipeline: unknown }).pipeline = async (commands: (string | number)[][]) => {
    const replies = await real(commands);
    if (hits === 0 && matches(commands)) {
      hits += 1;
      return fault;
    }
    return replies;
  };
  try {
    await work();
  } finally {
    (redis as unknown as { pipeline: unknown }).pipeline = real;
  }
  return hits;
}

async function main(): Promise<void> {
  redis.clear();
  mail.configure();
  await mail.setReady(true, { max24: 50_000, rate: 100 });
  process.env.STRIPE_SECRET_KEY = "sk_test_flow_unread_stand_in";
  process.env.RESEND_API_KEY = "re_test_flow_unread_stand_in";
  const OWNER = "unread@example.com";
  await claimHandle(OWNER, "unreadshop", "Unread Shop", "");
  await ensureStatsId(OWNER);
  await ensureListId(OWNER);
  await setStripeAccount(OWNER, "acct_1TestUnread01", true);
  await setSubscription(OWNER, { customerId: "cus_Unread0001", subscriptionId: "sub_Unread0001", active: true, tier: "pro", period: paidPeriod() });
  await setMailSettings(OWNER, { fromName: "Unread Shop", address: "1 Main St, Portland, OR 97201" });
  let store = (await storeForEmail(OWNER))!;
  const statsId = store.statsId!;
  const fields = await writeFields(statsId, [{ id: "lvl001", name: "Level", type: "choice", options: ["Beginner", "Pro"] }]);
  const stages = await readStages(statsId);
  await writeForm(statsId, parseForm({ id: "fieldform1", name: "Field", fields: [{ id: "q1mail", type: "email", label: "Email", required: true }] })!);
  await writeForm(statsId, parseForm({ id: "dealform01", name: "Deal", fields: [{ id: "q1mail", type: "email", label: "Email", required: true }] })!);
  const fieldFlow = await saveFlow(store, { name: "Field step", trigger: "form", formId: "fieldform1", active: true, steps: [{ delayHours: 0, action: { do: "field", field: "lvl001", value: "Pro" } }, { delayHours: 0, subject: "After the field", body: "B" }] }, { activate: true });
  if (!fieldFlow.ok) throw new Error(`setup: ${JSON.stringify(fieldFlow)}`);
  const dealFlow = await saveFlow(store, { name: "Deal step", trigger: "form", formId: "dealform01", active: true, steps: [{ delayHours: 0, action: { do: "deal", stage: stages[0].id, title: "Coaching" } }, { delayHours: 0, subject: "After the deal", body: "B" }] }, { activate: true });
  if (!dealFlow.ok) throw new Error(`setup: ${JSON.stringify(dealFlow)}`);
  const fieldFlowId = fieldFlow.flows.find((f) => f.name === "Field step")!.id;
  const dealFlowId = dealFlow.flows.find((f) => f.name === "Deal step")!.id;
  await upsertContact(store.listId!, "ana@example.com", { agreed: true, explicit: true, source: "free" }, ROOM);
  await upsertContact(store.listId!, "bea@example.com", { agreed: true, explicit: true, source: "free" }, ROOM);
  store = (await storeForEmail(OWNER))!;

  part("A field step whose fields read is unknown once");
  await enroll(store, "ana@example.com", { joined: false, form: "fieldform1" });
  const fieldHits = await onceUnknown((c) => c.length === 1 && c[0][0] === "GET" && String(c[0][1]).startsWith("nl:crm:fields:"), [7], run);
  const ana = await readRun(fieldFlowId, personOf("ana@example.com"));
  is("the unknown read was hit", fieldHits, 1);
  is("the run waits to be tried again, not held", ana?.run.status, "waiting");
  is("the step waits at step 0, once, saying why", [ana?.run.step, ana?.run.waits, ana?.run.note], [0, 1, "Your store's fields could not be read; tried again in a few minutes."]);
  is("nothing is logged as uncertain or failed", ana?.events.filter((e) => e.state === "uncertain" || e.state === "failed").length, 0);
  is("nothing was written", (await readValues(statsId, personKey(statsId, "ana@example.com"), fields)).lvl001 ?? "", "");

  part("A deal step whose pipelines read is unknown once");
  await enroll(store, "bea@example.com", { joined: false, form: "dealform01" });
  const dealHits = await onceUnknown((c) => c.length === 2 && c[0][0] === "GET" && String(c[0][1]).startsWith("nl:crm:pipes:"), [7, null], run);
  const bea = await readRun(dealFlowId, personOf("bea@example.com"));
  is("the unknown read was hit", dealHits, 1);
  is("the run waits to be tried again, not held", bea?.run.status, "waiting");
  is("the step waits at step 0, once, saying why", [bea?.run.step, bea?.run.waits, bea?.run.note], [0, 1, "Your deals board could not be read; tried again in a few minutes."]);
  is("nothing is logged as uncertain or failed", bea?.events.filter((e) => e.state === "uncertain" || e.state === "failed").length, 0);
  is("no deal was written", (await readDeals(statsId, stages)).filter((d) => d.email === "bea@example.com").length, 0);
  done();
}

void main();
