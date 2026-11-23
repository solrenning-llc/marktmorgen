/**
 * What the owed-follow-up note of an API write (lib/api-write.ts, oweKey; defects #3979, #4035 and #4077) adds to
 * one API request, at the most, as Upstash bills it, and its line in the cost registry ("api-write-owed").
 *
 *   - The note itself: read with the contact (GET), written before the write (SET), cleared after it (DEL); for a
 *     product given, written (SET) and claimed (DEL). At most OWE_COMMANDS a request.
 *   - The follow-up a retry finishes: a contact request starts at most 1 + MAX_CONTACT_TAGS moments, as a new contact
 *     with its labels always could; a label request at most one more than its own labels (an owed "joined"). That one
 *     more sequence check is priced here at its dearest: every active workflow of the dearest plan already started
 *     for the person, or the day's runs full, each claim tried and given back. The runs it starts are the plan's runs
 *     a day, already priced whole on the workflows line.
 *
 * Neither takes a unit of the store's API figure: nothing the customer reads changes. Synthetic: in-memory Redis.
 */
import { addProduct, claimHandle, ensureListId, ensureStatsId, setMailSettings, setProductLink, setSubscription, storeForEmail } from "@/lib/store";
import { makeKey } from "@/lib/api-keys";
import { MAX_CONTACT_TAGS, upsertContact } from "@/lib/contacts";
import { enroll, saveFlow, setFlowActive } from "@/lib/flows";
import { ACTIVE_FLOWS_BY_TIER, DAILY_RUNS_BY_TIER, TRIAL_ACTIVE_FLOWS } from "@/lib/flow-limits";
import { OWE_COMMANDS, OWE_SECONDS } from "@/lib/api-write";
import { STORE_ALLOWANCES } from "@/lib/store-allowance-rules";
import { POST as postLead } from "@/app/api/v1/leads/route";
import { POST as postLabels } from "@/app/api/v1/leads/labels/route";
import { POST as postAccess } from "@/app/api/v1/access/route";
import { readFileSync } from "node:fs";
import { API_WRITE_OWED_CHECK_BASE, API_WRITE_OWED_CHECK_PER_FLOW, COMMAND, COST_LINES, apiWriteOwedExtraCommands } from "./plan-cost-registry";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";
import { paidPeriod } from "./billing-period-fixture";
import { ROOM } from "./data-room";

type Commands = (string | number)[][];
globalThis.fetch = (async () => new Response(JSON.stringify({ error: { message: "no network in tests" } }), { status: 404 })) as typeof fetch;

const real = redis.pipeline.bind(redis);
/** While counting: every command billed as Upstash bills it (a script is one, plus each redis.call in it). */
let billed: number | null = null;
let noteCommands = 0;
let flowReads = 0;
let failFlowReads = false;
redis.pipeline = (async (commands: Commands) => {
  for (const command of commands) {
    if (billed !== null) {
      billed += 1;
      if (String(command[0]).toUpperCase() === "EVAL") billed += (String(command[1]).match(/redis\.call\(/g) ?? []).length;
    }
    if (String(command[1]).startsWith("nl:api:owe:")) noteCommands += 1;
    if (String(command[0]).toUpperCase() === "GET" && String(command[1]).startsWith("nl:mail:flows:")) {
      flowReads += 1;
      if (failFlowReads) throw new Error("synthetic: the workflows could not be read");
    }
  }
  return real(commands);
}) as typeof redis.pipeline;

const call = async (handler: (r: Request) => Promise<Response>, key: string, body: unknown) => {
  noteCommands = 0;
  flowReads = 0;
  const response = await handler(new Request("https://marktmorgen.com/api/v1/x", { method: "POST", headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" }, body: JSON.stringify(body) }));
  return { status: response.status, notes: noteCommands, enrolls: flowReads };
};

async function main(): Promise<void> {
  console.error = () => {};
  process.env.RESEND_API_KEY = "re_test_api_write_only_a_stand_in";
  redis.clear();
  const tier = "scale" as const;
  const most = Math.max(...Object.values(ACTIVE_FLOWS_BY_TIER));
  is("the dearest plan has the most active workflows", ACTIVE_FLOWS_BY_TIER[tier], most);
  const OWNER = "owed-cost@example.com";
  await claimHandle(OWNER, "owedcost", "Owed Cost", "");
  await ensureStatsId(OWNER);
  await ensureListId(OWNER);
  await setSubscription(OWNER, { customerId: "cus_OwedCost01", subscriptionId: "sub_OwedCost01", active: true, tier, period: paidPeriod() });
  await setMailSettings(OWNER, { fromName: "Owed Cost", address: "1 Main St, Portland, OR 97201" });
  const guide = await addProduct(OWNER, "The Guide", "", "12", null);
  if (!guide.ok) throw new Error("no product");
  await setProductLink(OWNER, guide.product.id, "https://example.com/guide");
  let store = (await storeForEmail(OWNER))!;
  const tags = Array.from({ length: MAX_CONTACT_TAGS }, (_, i) => `t${i}`);
  // Every active workflow starts on "joined": the owed "joined" a label request finishes checks each of them.
  const ids: string[] = [];
  for (let i = 0; i < most; i += 1) {
    const saved = await saveFlow(store, { name: `Welcome ${i}`, trigger: "joined", steps: [{ delayHours: 1, subject: `Welcome ${i}`, body: "Hello." }] });
    if (!saved.ok) throw new Error(`no workflow ${i}: ${JSON.stringify(saved)}`);
    ids.push(saved.flows.find((f) => f.name === `Welcome ${i}`)!.id);
    await setFlowActive(store, ids[i], true);
  }
  store = (await storeForEmail(OWNER))!;
  const writer = await makeKey(store.sid!, "Sync", Date.now(), true);
  if (!writer.ok) throw new Error("no key");

  part("One more sequence check, at its dearest");
  const measure = async (email: string) => {
    billed = 0;
    try {
      await enroll(store, email, { joined: true });
      return billed as number;
    } finally {
      billed = null;
    }
  };
  await upsertContact(store.listId!, "first@example.com", { agreed: true, explicit: true, source: "free" }, ROOM);
  await enroll(store, "first@example.com", { joined: true });
  const started = await measure("first@example.com");
  // Fill the day's runs, then a new person's claims are each tried and given back.
  for (let i = 0; i * most < DAILY_RUNS_BY_TIER[tier]; i += 1) {
    await upsertContact(store.listId!, `fill${i}@example.com`, { agreed: true, explicit: true, source: "free" }, ROOM);
    await enroll(store, `fill${i}@example.com`, { joined: true });
  }
  await upsertContact(store.listId!, "late@example.com", { agreed: true, explicit: true, source: "free" }, ROOM);
  const full = await measure("late@example.com");
  const priced = (flows: number) => API_WRITE_OWED_CHECK_BASE + API_WRITE_OWED_CHECK_PER_FLOW * flows;
  is(`${most} workflows: every one already started, ${started} commands; the day full, ${full}; priced ${priced(most)}`, [started > 0, full > 0, Math.max(started, full) <= priced(most)], [true, true, true]);
  // With one active workflow, the same two cases: the price grows with the plan's workflows, never under a measure.
  for (const id of ids.slice(1)) await setFlowActive(store, id, false);
  store = (await storeForEmail(OWNER))!;
  const oneStarted = await measure("first@example.com");
  await upsertContact(store.listId!, "later@example.com", { agreed: true, explicit: true, source: "free" }, ROOM);
  const oneFull = await measure("later@example.com");
  is(`one workflow: already started, ${oneStarted} commands; the day full, ${oneFull}; priced ${priced(1)}`, [oneStarted > 0, oneFull > 0, Math.max(oneStarted, oneFull) <= priced(1)], [true, true, true]);
  is("each workflow is priced at least at what one more workflow measured adds", API_WRITE_OWED_CHECK_PER_FLOW * (most - 1) >= Math.max(started, full) - Math.max(oneStarted, oneFull), true);
  for (const id of ids.slice(1)) await setFlowActive(store, id, true);
  store = (await storeForEmail(OWNER))!;

  part("The note's own commands and the starts, through the real routes");
  failFlowReads = true;
  const lead = await call(postLead, writer.key, { email: "ana@example.com", tags, agreed: true });
  failFlowReads = false;
  is("a new contact whose starts failed: try again", lead.status, 503);
  const leadRetry = await call(postLead, writer.key, { email: "ana@example.com", tags, agreed: true });
  is(`its retry: ${leadRetry.notes} note commands, ${leadRetry.enrolls} starts (a new contact with its labels: ${1 + MAX_CONTACT_TAGS})`, [leadRetry.status, leadRetry.notes <= OWE_COMMANDS, leadRetry.enrolls <= 1 + MAX_CONTACT_TAGS], [200, true, true]);
  // A contact whose "joined" and labels are owed, then a label request that finishes them and adds its own.
  failFlowReads = true;
  await call(postLead, writer.key, { email: "ben@example.com", tags: tags.slice(0, MAX_CONTACT_TAGS - 1), agreed: true });
  failFlowReads = false;
  const label = await call(postLabels, writer.key, { email: "ben@example.com", add: [tags[MAX_CONTACT_TAGS - 1]] });
  is(`a label request finishing an owed contact: ${label.notes} note commands, ${label.enrolls} starts, one more than its own labels can be (${MAX_CONTACT_TAGS})`, [label.status, label.notes <= OWE_COMMANDS, label.enrolls <= MAX_CONTACT_TAGS + 1], [200, true, true]);
  const fresh = await call(postLabels, writer.key, { email: "ben@example.com", add: ["new-one"] });
  is(`a label request that adds a label: ${fresh.notes} note commands`, [fresh.status, fresh.notes <= OWE_COMMANDS], [200, true]);
  const given = await call(postAccess, writer.key, { email: "cy@example.com", product: guide.product.id, notify: true });
  is(`a product given with its email: ${given.notes} note commands`, [given.status, given.notes <= OWE_COMMANDS], [200, true]);
  const again = await call(postAccess, writer.key, { email: "cy@example.com", product: guide.product.id, notify: true });
  is(`asked again: ${again.notes} note command`, [again.status, again.notes <= OWE_COMMANDS], [200, true]);
  const notes = [lead, leadRetry, label, fresh, given, again].map((r) => r.notes);
  is(`the note's commands a request (${Math.max(...notes)}) are within OWE_COMMANDS (${OWE_COMMANDS})`, Math.max(...notes) <= OWE_COMMANDS, true);
  is("the note is gone by itself within a day", OWE_SECONDS <= 86_400, true);

  part("Priced on every API request of each plan, at its own workflows");
  is(`the extra is the note (${OWE_COMMANDS}) and one sequence check: ${apiWriteOwedExtraCommands(most)} commands at ${most} workflows`, apiWriteOwedExtraCommands(most), OWE_COMMANDS + priced(most));
  const line = COST_LINES.find((l) => l.id === "api-write-owed");
  is("its line is in the registry", Boolean(line), true);
  for (const each of Object.keys(ACTIVE_FLOWS_BY_TIER) as (keyof typeof ACTIVE_FLOWS_BY_TIER)[]) {
    const commands = apiWriteOwedExtraCommands(ACTIVE_FLOWS_BY_TIER[each]);
    const usd = STORE_ALLOWANCES[each].api * commands * COMMAND;
    is(`${each}: ${STORE_ALLOWANCES[each].api} API requests x ${commands} commands = $${usd.toFixed(5)} a month`, line ? Math.abs(line.monthlyUsd(each) - usd) < 1e-12 : false, true);
  }
  is(`a trial's API requests carry it at the trial's ${TRIAL_ACTIVE_FLOWS} workflows in the worst of a store that pays nothing`, /\+ allowances\.api \* apiWriteOwedExtraCommands\(TRIAL_ACTIVE_FLOWS\) \* COMMAND/.test(readFileSync("tests/plan-cost-registry.ts", "utf8")), true);

  done();
}

void main().catch((error) => {
  console.log(error);
  process.exit(1);
});
