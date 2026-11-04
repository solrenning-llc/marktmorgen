import { NextRequest } from "next/server";
import { formOpportunityRef, createFormOpportunity, readFormOpportunity } from "@/lib/form-opportunity";
import { parseForm, type FormResponse } from "@/lib/forms";
import { addResponse, writeForm, dropForm } from "@/lib/form-store";
import { claimHandle, ensureStatsId, ensureStoreId, storeForEmail } from "@/lib/store";
import { SESSION_COOKIE, openSession } from "@/lib/auth";
import { DEFAULT_STAGES, MAX_DEALS, type Deal } from "@/lib/crm-rules";
import { dealVersion, readDeals } from "@/lib/crm";
import { putMember } from "@/lib/team";
import { POST } from "@/app/api/store/form-opportunity/route";
import { POST as editCrm } from "@/app/api/store/crm/route";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";
import { ROOM } from "./data-room";

async function main() {
  redis.clear(); process.env.UPSTASH_REDIS_REST_URL ??= "http://stub";
  const owner = "uniqueforms@example.com";
  await claimHandle(owner, "uniqueformshop", "Unique Forms", ""); await ensureStatsId(owner); await ensureStoreId(owner);
  const store = (await storeForEmail(owner))!; const statsId = store.statsId!;
  const session = await openSession(owner);
  const form = parseForm({ id: "uniqueform", name: "Application", fields: [{ id: "email1", type: "email", label: "Email", required: true }], offerList: false })!;
  await writeForm(statsId, form);
  const response: FormResponse = { at: 1800000000, page: "", answers: { email1: "lead@example.com" }, outcome: "", joined: false };
  await addResponse(statsId, form.id, response, ROOM);
  const ref = formOpportunityRef(statsId, form.id, response);
  const draft = { title: "Reviewed application", email: "lead@example.com", note: "Initial review", cents: 0, stage: "lead00", nextAction: "Review", dueDate: "2026-10-16", assignee: owner };
  const send = (responseRef = ref, change = {}, token = session) => POST(new NextRequest("https://marktmorgen.com/api/store/form-opportunity", { method: "POST", headers: { "content-type": "application/json", "x-nimbus-store": store.sid, cookie: SESSION_COOKIE + "=" + token }, body: JSON.stringify({ form: form.id, responseRef, deal: { ...draft, ...change } }) }));
  part("Stable identities and concurrent conversions");
  is("identity is scoped to the store and form", [ref === formOpportunityRef("other", form.id, response), ref === formOpportunityRef(statsId, "otherform0", response)], [false, false]);
  is("answer key order does not change response identity", formOpportunityRef(statsId, form.id, { ...response, answers: { first: "a", second: "b" } }), formOpportunityRef(statsId, form.id, { ...response, answers: { second: "b", first: "a" } }));
  const replies = await Promise.all([send(), send(ref, { note: "Competing review" })]);
  const records = await Promise.all(replies.map(reply => reply.json()));
  is("simultaneous requests create one deal and return the same ID", [records.map(record => record.state).sort(), new Set(records.map(record => record.deal?.id)).size, (await readDeals(statsId, DEFAULT_STAGES)).length], [["created", "existing"], 1, 1]);
  const kept = (await readDeals(statsId, DEFAULT_STAGES))[0];
  const edited = await editCrm(new NextRequest("https://marktmorgen.com/api/store/crm", { method: "POST", headers: { "content-type": "application/json", "x-nimbus-store": store.sid, cookie: SESSION_COOKIE + "=" + session }, body: JSON.stringify({ action: "deal", version: dealVersion(String((await redis.pipeline([["HGET", "nl:crm:deals:" + statsId, kept.id]]))[0])), deal: { ...kept, note: "Later work", stage: "won000", formResponseRef: "f".repeat(64) } }) }));
  is("ordinary edits preserve the server-owned origin", [(await edited.json()).ok, (await readDeals(statsId, DEFAULT_STAGES))[0]?.formResponseRef], [true, ref]);
  const again = await (await send()).json();
  is("retry returns existing opportunity without undoing later edits", [again.state, again.deal.note, again.deal.stage, (await readDeals(statsId, DEFAULT_STAGES)).length], ["existing", "Later work", "won000", 1]);
  is("a made-up response cannot create an opportunity", [(await (await send("a".repeat(64))).json()).error, (await readDeals(statsId, DEFAULT_STAGES)).length], ["response_gone", 1]);

  part("Unknown replies are recoverable without duplication");
  const second = { ...response, at: response.at + 1 }; await addResponse(statsId, form.id, second, ROOM);
  const secondRef = formOpportunityRef(statsId, form.id, second);
  const original = redis.pipeline; let lose = true;
  try {
    redis.pipeline = async commands => { const result = await original.call(redis, commands); if (lose && commands.some(command => command[0] === "EVAL" && String(command[1]).startsWith("-- marktmorgen:form-opportunity:v1"))) { lose = false; throw new Error("Injected lost commit reply"); } return result; };
    is("lost confirmation does not claim failure before write", (await (await send(secondRef)).json()).error, "conversion_unconfirmed");
  } finally { redis.pipeline = original; }
  const recovered = await (await send(secondRef)).json();
  is("retry after a lost reply finds the saved deal", [recovered.state, (await readDeals(statsId, DEFAULT_STAGES)).length], ["existing", 2]);
  const unavailableResponse = { ...response, at: response.at + 20 }; await addResponse(statsId, form.id, unavailableResponse, ROOM);
  const unavailableRef = formOpportunityRef(statsId, form.id, unavailableResponse);
  for (const mode of ["unsupported", "malformed"]) {
    try {
      redis.pipeline = async commands => { if (commands.some(command => command[0] === "EVAL" && String(command[1]).startsWith("-- marktmorgen:form-opportunity:v1"))) { if (mode === "unsupported") throw new Error("Script unavailable"); return [null]; } return original.call(redis, commands); };
      is("unsupported script or unknown result never falls back to an ordinary write", [(await (await send(unavailableRef)).json()).error, (await readDeals(statsId, DEFAULT_STAGES)).length], ["conversion_unconfirmed", 2]);
    } finally { redis.pipeline = original; }
  }
  await putMember(store, "supportunique@example.com", "support");
  const supportSession = await openSession("supportunique@example.com");
  is("support cannot convert form answers without export permission", (await send(ref, {}, supportSession)).status, 403);
  is("signed-out conversion is refused", (await send(ref, {}, "")).status, 401);

  part("Capacity and collisions fail closed");
  const key = "nl:crm:deals:" + statsId;
  for (let i = 0; i < MAX_DEALS - 2; i++) await redis.pipeline([["HSET", key, "fill" + i, "invalid"]]);
  const third = { ...response, at: response.at + 2 }; await addResponse(statsId, form.id, third, ROOM);
  is("new conversions respect the whole CRM hash capacity", (await (await send(formOpportunityRef(statsId, form.id, third))).json()).error, "full");
  is("existing conversions can still be retrieved at capacity", (await (await send()).json()).state, "existing");
  const collidingRef = "1234567890" + "a".repeat(54);
  const fixture: Deal = { ...kept, id: collidingRef.slice(0,10), formResponseRef: "b".repeat(64) };
  await redis.pipeline([["HSET", "nl:crm:deals:collision", fixture.id, JSON.stringify(fixture)]]);
  let collisionRefused = false; try { await createFormOpportunity("collision", collidingRef, fixture, DEFAULT_STAGES, ROOM); } catch { collisionRefused = true; }
  is("identifier collisions never return or overwrite an unrelated deal", [collisionRefused, (await readDeals("collision", DEFAULT_STAGES))[0].formResponseRef], [true, "b".repeat(64)]);
  for (let i = 0; i < 50; i++) await addResponse(statsId, form.id, { ...response, at: response.at + 100 + i }, ROOM);
  is("unconverted responses outside the visible window remain unavailable", [(await (await send(formOpportunityRef(statsId, form.id, third))).json()).error, (await readDeals(statsId, DEFAULT_STAGES)).length], ["response_gone", 2]);
  const oldRetry = await (await send(ref, { title: "", stage: "removed" })).json();
  is("committed conversions remain recoverable after the source ages out without replaying draft edits", [oldRetry.state, oldRetry.deal?.note, oldRetry.deal?.stage, (await readDeals(statsId, DEFAULT_STAGES)).length], ["existing", "Later work", "won000", 2]);
  is("recovery remains scoped to the store", await readFormOpportunity("different-store", ref, DEFAULT_STAGES), null);
  for (const malformed of [[], [undefined], [123], ["{"], [JSON.stringify(fixture)]]) {
    let refused = false;
    try {
      redis.pipeline = async commands => commands.some(command => command[0] === "HGET" && command[1] === key) ? malformed : original.call(redis, commands);
      await readFormOpportunity(statsId, ref, DEFAULT_STAGES);
    } catch { refused = true; } finally { redis.pipeline = original; }
    is("unconfirmed or conflicting reads never claim recovery", refused, true);
  }
  await dropForm(statsId, form.id, ROOM);
  const afterRemoval = await (await send()).json();
  is("removing the source form does not hide a committed opportunity", [afterRemoval.state, afterRemoval.deal?.formResponseRef], ["existing", ref]);
  is("a removed form cannot create an opportunity from an unknown reference", (await (await send("c".repeat(64))).json()).error, "unknown");
  part("Distinct submission identities");
  const identifiedA = { ...response, id: "1".repeat(32) };
  const identifiedB = { ...response, id: "2".repeat(32) };
  const refA = formOpportunityRef(statsId, form.id, identifiedA);
  const refB = formOpportunityRef(statsId, form.id, identifiedB);
  is("equal answers in the same second remain distinct for different server IDs", refA === refB, false);
  is("a stored submission keeps its identity independently of answer key order", refA, formOpportunityRef(statsId, form.id, { ...identifiedA, answers: { second: "b", first: "a" } }));
  is("server IDs are scoped by store and form", [refA === formOpportunityRef("other-store", form.id, identifiedA), refA === formOpportunityRef(statsId, "otherform0", identifiedA)], [false, false]);
  is("invalid IDs retain the legacy fingerprint", formOpportunityRef(statsId, form.id, { ...response, id: "invalid" }), ref);
  const distinct = await Promise.all([createFormOpportunity("distinct-submissions", refA, kept, DEFAULT_STAGES, ROOM), createFormOpportunity("distinct-submissions", refB, kept, DEFAULT_STAGES, ROOM)]);
  is("identical distinct submissions can create separate reviewed opportunities", [distinct.map(result => result.state), (await readDeals("distinct-submissions", DEFAULT_STAGES)).length], [["created", "created"], 2]);
  done();
}
main().catch(error => { console.error(error); process.exit(1); });
