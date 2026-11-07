/**
 * A store's pipelines read in an unknown shape are unknown, never the
 * default stages (CX-123 rules 24 and 30).
 *
 * Scenario from Claude 6's proof (claude6/email-page-reads-proof @ 9a92e2a2,
 * tests/email-page-reads-unknown.proof.ts, part (b)): with the store's saved
 * pipelines answered as "{not json", lib/crm.ts readPipelines fell back to
 * the default stages (lead00, talk00, offr00, won000, lost00); the email
 * studio offered those, and lib/flows.ts saveFlow, reading the stages the
 * same way, saved a sequence started by "lead00" with a deal step to
 * "won000", stages no pipeline of the store has.
 *
 * Here: the read itself (every unknown shape refused, an absent key still the
 * board the store always had), each caller that writes (saveFlow, the email
 * route, the form-to-deal route, a workflow's deal step) refusing or waiting
 * with nothing written, and the healthy control.
 *
 * Nothing real: the Redis stub, a stand-in email provider, synthetic stores.
 */
import { NextRequest } from "next/server";
import { POST as mailRoute } from "@/app/api/store/mail/route";
import { POST as formOpportunityRoute } from "@/app/api/store/form-opportunity/route";
import { SESSION_COOKIE, openSession } from "@/lib/auth";
import { upsertContact } from "@/lib/contacts";
import { readDeals, readPipelines, readStages, readValues, writeFields } from "@/lib/crm";
import { personKey } from "@/lib/person-key";
import { DEFAULT_STAGES } from "@/lib/crm-rules";
import { enroll, readFlows, saveFlow, sendDueSteps } from "@/lib/flows";
import { claimHandle, ensureListId, ensureStatsId, setMailSettings, setSubscription, storeForEmail, storeForHandle } from "@/lib/store";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";
import { paidPeriod } from "./billing-period-fixture";
import { ROOM } from "./data-room";
import { installSesMailFixture } from "./ses-mail-fixture";

const mail = installSesMailFixture({
  fallback: () => new Response(JSON.stringify({ object: "list", data: [], has_more: false })),
});

const OWNER = "pipes-unknown@example.com";
const STAGE = "stgqa1";
const WON = "stgwn1";
const LOST = "stglo1";
const PIPES = [{ id: "sales0", name: "Coaching", stages: [{ id: STAGE, name: "Qualified", kind: "open" }, { id: WON, name: "Signed", kind: "won" }, { id: LOST, name: "Gone", kind: "lost" }] }];
const DEFAULT_IDS = DEFAULT_STAGES.map((s) => s.id);

/** What Redis answers, by key, for a GET of these keys while set; everything else answers truthfully. */
const faults = new Map<string, unknown>();
const original = redis.pipeline.bind(redis);
redis.pipeline = (async (commands: (string | number)[][]) => {
  const answers = await original(commands);
  return faults.size ? answers.map((answer, i) => (commands[i][0] === "GET" && faults.has(String(commands[i][1])) ? faults.get(String(commands[i][1])) : answer)) : answers;
}) as typeof redis.pipeline;

/** The whole reply to the next pipeline sent replaced by `reply`. */
async function wholeReply<T>(reply: unknown, run: () => Promise<T>): Promise<T> {
  const before = redis.pipeline;
  let first = true;
  redis.pipeline = (async (commands: (string | number)[][]) => {
    if (first) {
      first = false;
      return reply;
    }
    return before(commands);
  }) as typeof redis.pipeline;
  try {
    return await run();
  } finally {
    redis.pipeline = before;
  }
}

/** The name of what was thrown, or "returned" with what came back. */
async function outcome(run: () => Promise<unknown>): Promise<string> {
  try {
    const got = await run();
    return `returned ${JSON.stringify(got).slice(0, 80)}`;
  } catch (error) {
    return (error as Error).name;
  }
}

async function main(): Promise<void> {
  redis.clear();
  mail.configure();
  await mail.setReady(true, { max24: 50_000, rate: 100 });
  process.env.STRIPE_SECRET_KEY = "sk_test_pipes_only_a_stand_in";
  process.env.RESEND_API_KEY = "re_test_pipes_only_a_stand_in";

  await claimHandle(OWNER, "pipesunknown", "Pipes Unknown", "");
  await ensureStatsId(OWNER);
  await ensureListId(OWNER);
  await setSubscription(OWNER, { customerId: "cus_PipesUnknown01", subscriptionId: "sub_PipesUnknown01", active: true, tier: "scale", period: paidPeriod() });
  await setMailSettings(OWNER, { fromName: "Pipes Unknown", address: "1 Main St, Portland, OR 97201" });
  let store = (await storeForEmail(OWNER))!;
  const sid = store.statsId!;
  const list = store.listId!;
  const pipesKey = `nl:crm:pipes:${sid}`;
  const stagesKey = `nl:crm:stages:${sid}`;

  part("Control: an absent record is the board the store always had; a saved one reads as saved");
  is("nothing saved: the default stages", (await readStages(sid)).map((s) => s.id), DEFAULT_IDS);
  await redis.pipeline([["SET", stagesKey, JSON.stringify(PIPES[0].stages)]]);
  is("only the board's old record: its stages, as the first pipeline", (await readStages(sid)).map((s) => s.id), [STAGE, WON, LOST]);
  await redis.pipeline([["DEL", stagesKey], ["SET", pipesKey, JSON.stringify(PIPES)]]);
  is("saved pipelines: exactly those", (await readPipelines(sid)).map((p) => [p.id, p.stages.map((s) => s.id)]), [["sales0", [STAGE, WON, LOST]]]);

  part("The read: every unknown shape is unknown, never the default stages");
  for (const [label, reply] of [
    ["the whole reply not a list", "OK"],
    ["the reply missing", []],
    ["one answer for two reads", ["x"]],
  ] as const) {
    is(`${label}: refused`, await outcome(() => wholeReply(reply, () => readPipelines(sid))), "CrmSchemaReadUnavailable");
  }
  for (const [label, pipes, legacy] of [
    ["saved pipelines that do not read (Claude 6's proof)", "{not json", null],
    ["saved pipelines not a string", 42, null],
    ["saved pipelines not a list", JSON.stringify({ id: "sales0" }), null],
    ["the old board record not a string", null, 42],
    ["the old board record that does not read", null, "{not json"],
    ["the old board record with a stage that does not read", null, JSON.stringify([...PIPES[0].stages, { id: "BAD" }])],
  ] as const) {
    faults.set(pipesKey, pipes);
    faults.set(stagesKey, legacy);
    is(`${label}: readPipelines refused`, await outcome(() => readPipelines(sid)), "CrmSchemaReadUnavailable");
    is(`${label}: readStages refused`, await outcome(() => readStages(sid)), "CrmSchemaReadUnavailable");
    faults.clear();
  }

  part("saveFlow: a sequence is never checked against stages that are not the store's (Claude 6's proof, part (b))");
  const nurture = await saveFlow(store, { name: "Deal nurture", trigger: "stage", stageId: STAGE, steps: [{ delayHours: 0, subject: "", body: "", action: { do: "deal", stage: WON, title: "" } }] });
  is("setup: a sequence on the store's own stage saves", nurture.ok, true);
  const nurtureId = nurture.ok ? nurture.flows.find((f) => f.name === "Deal nurture")!.id : "";
  const before = JSON.stringify(await readFlows(list));
  const onDefaults = { id: nurtureId, name: "Deal nurture", trigger: "stage", stageId: "lead00", steps: [{ delayHours: 0, subject: "", body: "", action: { do: "deal", stage: "won000", title: "" } }] };
  faults.set(pipesKey, "{not json");
  is("the defaults' lead00 and won000, with the pipelines unknown: refused, never saved", await outcome(() => saveFlow(store, onDefaults)), "CrmSchemaReadUnavailable");
  faults.clear();
  is("nothing written", JSON.stringify(await readFlows(list)) === before, true);
  is("control: the same stages, now known not to be the store's, are turned away as a stage", await saveFlow(store, onDefaults), { ok: false, reason: "stage" });

  part("The email route says the pipelines could not be read, and writes nothing");
  const token = await openSession(OWNER);
  const post = async (route: (request: NextRequest) => Promise<Response>, path: string, body: Record<string, unknown>) => {
    const response = await route(new NextRequest(`https://local.example${path}`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Origin: "https://local.example", Host: "local.example", Cookie: `${SESSION_COOKIE}=${token}` },
      body: JSON.stringify(body),
    }));
    return [response.status, ((await response.json()) as { error?: string }).error ?? "ok"];
  };
  faults.set(pipesKey, "{not json");
  is("saving the sequence on the defaults' stages: 503, unavailable", await post(mailRoute, "/api/store/mail", { action: "flow", flow: onDefaults }), [503, "crm_schema_read_unavailable"]);
  faults.clear();
  is("nothing written", JSON.stringify(await readFlows(list)) === before, true);

  part("The form-to-deal route says the pipelines could not be read");
  faults.set(pipesKey, "{not json");
  is("turning a form answer into a deal: 503, unavailable", await post(formOpportunityRoute, "/api/store/form-opportunity", { form: "noform0001", responseRef: "a".repeat(64) }), [503, "crm_schema_read_unavailable"]);
  faults.clear();

  part("A workflow's deal step waits while the pipelines are unknown, and runs once they read");
  const joined = await saveFlow(store, { name: "Joined: deal", trigger: "joined", active: true, steps: [{ delayHours: 0, subject: "", body: "", action: { do: "deal", stage: WON, title: "Joined" } }] }, { activate: true });
  is("setup: a sequence with a deal step on the store's own stage", joined.ok, true);
  await upsertContact(list, "ana@example.com", { agreed: true, explicit: true, source: "free" }, ROOM);
  store = (await storeForEmail(OWNER))!;
  await enroll(store, "ana@example.com", { joined: true });
  const run = () => sendDueSteps((handle) => storeForHandle(handle), Date.now() + 20_000);
  faults.set(pipesKey, "{not json");
  await run();
  faults.clear();
  const stages = await readStages(sid);
  is("while unknown: no deal written", (await readDeals(sid, stages)).filter((d) => d.email === "ana@example.com").length, 0);
  // Deferred, not "failed: the stage was removed" nor "uncertain" (held, never tried again by itself): back in the
  // queue for later. The wait is passed by making what is queued due now.
  const [queued] = await redis.pipeline([["ZRANGEBYSCORE", "nl:mail:flowq", "-inf", "+inf"]]);
  is("while unknown: the step is queued again, not ended", (queued as string[]).length, 1);
  await redis.pipeline((queued as string[]).map((member) => ["ZADD", "nl:mail:flowq", 0, member]));
  await run();
  is("once they read: the deal is made in the store's own stage", (await readDeals(sid, stages)).filter((d) => d.email === "ana@example.com").map((d) => d.stage), [WON]);


  part("Fields read in an unknown shape are unknown too, never none (review of #2981, LEVE 2; rule 30)");
  const fieldsKey = `nl:crm:fields:${sid}`;
  const GOAL = { id: "fld001", name: "Goal", type: "text" as const, options: [] as string[] };
  await writeFields(sid, [GOAL]);
  const fieldFlow = { name: "Joined: goal", trigger: "joined", active: true, steps: [{ delayHours: 0, subject: "", body: "", action: { do: "field", field: GOAL.id, value: "Launch" } }] };
  const flowsBefore = JSON.stringify(await readFlows(list));
  for (const [label, reply] of [
    ["fields that do not read", "{not json"],
    ["fields not a string", 42],
    ["fields not a list", JSON.stringify(GOAL)],
    ["fields with one that does not read", JSON.stringify([GOAL, { id: "BAD" }])],
  ] as const) {
    faults.set(fieldsKey, reply);
    is(`${label}: a sequence setting a field is refused as unavailable, not as a bad step`, await outcome(() => saveFlow(store, fieldFlow, { activate: true })), "CrmSchemaReadUnavailable");
    faults.clear();
  }
  is("nothing written", JSON.stringify(await readFlows(list)) === flowsBefore, true);
  faults.set(fieldsKey, "{not json");
  is("the email route: 503, unavailable", await post(mailRoute, "/api/store/mail", { action: "flow", flow: fieldFlow }), [503, "crm_schema_read_unavailable"]);
  faults.clear();
  is("nothing written by the route", JSON.stringify(await readFlows(list)) === flowsBefore, true);
  const goal = await saveFlow(store, fieldFlow, { activate: true });
  is("control: with the fields known, the same sequence saves", goal.ok, true);

  part("A workflow's field step waits while the fields are unknown, and runs once they read");
  await upsertContact(list, "bea@example.com", { agreed: true, explicit: true, source: "free" }, ROOM);
  store = (await storeForEmail(OWNER))!;
  await redis.pipeline([["DEL", "nl:mail:flowq"]]);
  await enroll(store, "bea@example.com", { joined: true });
  const queuedFor = async () => ((await redis.pipeline([["ZRANGEBYSCORE", "nl:mail:flowq", "-inf", "+inf"]]))[0] as string[]);
  const beaKey = personKey(sid, "bea@example.com");
  faults.set(fieldsKey, "{not json");
  await run();
  faults.clear();
  is("while unknown: no value written", (await readValues(sid, beaKey, [GOAL]))[GOAL.id] ?? "", "");
  const waiting = await queuedFor();
  // The deal workflow's step for bea ran and ended; only the field step is back in the queue, not ended as "removed".
  is("while unknown: the field step is queued again, not ended as removed", waiting.length, 1);
  await redis.pipeline(waiting.map((member) => ["ZADD", "nl:mail:flowq", 0, member]));
  await run();
  is("once they read: the field is set", (await readValues(sid, beaKey, [GOAL]))[GOAL.id], "Launch");

  done();
}

void main();
