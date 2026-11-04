/**
 * 639 [GL7](7): edge cases of each teammate's pipeline access found in
 * review, through the real routes, session and store
 * (app/api/store/crm, app/api/store/pipeline-access, lib/crm.ts,
 * lib/pipeline-access.ts, lib/team.ts, components/pipeline-access-editor.tsx).
 * Each check here failed before its fix.
 */
import { readFileSync } from "node:fs";
import { NextRequest } from "next/server";
import { POST as CRM } from "@/app/api/store/crm/route";
import { POST as PACC } from "@/app/api/store/pipeline-access/route";
import { SESSION_COOKIE, openSession } from "@/lib/auth";
import { readPipelines } from "@/lib/crm";
import { copyPipelineAccess, readAllPipelineAccess, readPipelineAccess, writePipelineAccess } from "@/lib/pipeline-access";
import { redisPipeline } from "@/lib/redis";
import { claimHandle, ensureStatsId, ensureStoreId, setStripeAccount, setSubscription, storeForEmail } from "@/lib/store";
import { dataKey } from "@/lib/store-data";
import { dataBytes } from "@/lib/store-data-rules";
import { moveMemberships, putMember, readLog, readTeam } from "@/lib/team";
import { store as redis } from "./redis-stub";
import { paidPeriod } from "./billing-period-fixture";
import { done, is, part } from "./check";

type Reply = { ok?: boolean; error?: string; message?: string; access?: Record<string, string>; deal?: { id: string }; pipelines?: { id: string }[] };

async function main(): Promise<void> {
  redis.clear();
  const owner = "pedges@example.com";
  await claimHandle(owner, "pedges", "Pipe Edges", "");
  await ensureStatsId(owner);
  await ensureStoreId(owner);
  await setStripeAccount(owner, "acct_1TestPipeEdg01", true);
  await setSubscription(owner, { customerId: "cus_PipeEdges01", subscriptionId: "sub_PipeEdges01", active: true, tier: "pro", period: paidPeriod() });
  const store = (await storeForEmail(owner))!;
  const statsId = store.statsId!;
  await putMember(store, "sam@example.com", "support");
  const cookie = (who: string) => openSession(who).then((s) => `${SESSION_COOKIE}=${s}`);
  const call = async (route: typeof CRM, path: string, who: string, body: unknown) => {
    const response = await route(new NextRequest(`https://marktmorgen.com/api/store/${path}`, { method: "POST", headers: { "content-type": "application/json", cookie: await cookie(who) }, body: typeof body === "string" ? body : JSON.stringify(body) }));
    return { status: response.status, body: (await response.json()) as Reply };
  };
  const crm = (who: string, body: Record<string, unknown>) => call(CRM, "crm", who, body);
  const pacc = (body: unknown) => call(PACC, "pipeline-access", owner, body);
  const workshops = { id: "wkshp1", name: "Workshops", stages: [{ id: "wnew01", name: "New", kind: "open" }, { id: "wtlk01", name: "Talking", kind: "open" }, { id: "wwon01", name: "Won", kind: "won" }, { id: "wlost1", name: "Lost", kind: "lost" }] };
  is("(the owner adds Workshops)", (await crm(owner, { action: "pipeline", pipeline: workshops, moves: {} })).status, 200);
  const dealsKey = `nl:crm:deals:${statsId}`;
  const made = await crm(owner, { action: "deal", deal: { title: "W", email: "", cents: 1, stage: "wtlk01", note: "" } });
  const dealId = made.body.deal!.id;

  part("The older stages request changes the pipeline that is first now");
  await writePipelineAccess(statsId, "sam@example.com", { wkshp1: "none" }, store);
  // Sales is empty, and Sam may change it: Sam removes it, so Workshops, which Sam may not see, is first.
  is("(Sam removes the empty Sales pipeline)", (await crm("sam@example.com", { action: "unpipeline", id: "sales0", moveTo: "" })).status, 200);
  is("(Workshops is first now)", (await readPipelines(statsId)).map((p) => p.id), ["wkshp1"]);
  const legacy = await crm("sam@example.com", { action: "stages", stages: [{ id: "xnew01", name: "Hijacked", kind: "open" }, { id: "xwon01", name: "Won", kind: "won" }, { id: "xlst01", name: "Lost", kind: "lost" }] });
  is("Sam cannot rewrite Workshops' stages through it: refused as access, and nothing changes", [legacy.status, legacy.body.error, (await readPipelines(statsId)).map((p) => [p.id, p.stages.map((s) => s.name)]), JSON.parse(String((await redisPipeline([["HGET", dealsKey, dealId]]))[0])).stage], [403, "pipeline_access", [["wkshp1", ["New", "Talking", "Won", "Lost"]]], "wtlk01"]);
  await writePipelineAccess(statsId, "sam@example.com", {}, store);
  const allowed = await crm("sam@example.com", { action: "stages", stages: [{ id: "wnew01", name: "New", kind: "open" }, { id: "wtlk01", name: "Talking", kind: "open" }, { id: "wwon01", name: "Won", kind: "won" }, { id: "wlost1", name: "Lost", kind: "lost" }] });
  is("someone who may change the first pipeline still can", allowed.status, 200);

  part("A deal in no pipeline is moved only by someone who may change the first one");
  const coaching = { id: "coach1", name: "Coaching", stages: [{ id: "cnew01", name: "New", kind: "open" }, { id: "cwon01", name: "Won", kind: "won" }, { id: "clst01", name: "Lost", kind: "lost" }] };
  is("(the owner adds Coaching)", (await crm(owner, { action: "pipeline", pipeline: coaching, moves: {} })).status, 200);
  await redisPipeline([["HSET", dealsKey, "orphan0001", JSON.stringify({ id: "orphan0001", title: "Orphan", email: "", cents: 5, stage: "orph01", note: "", createdAt: 1, updatedAt: 1 })]]);
  await writePipelineAccess(statsId, "sam@example.com", { wkshp1: "view" }, store);
  const renamed = await crm("sam@example.com", { action: "pipeline", pipeline: { ...coaching, name: "Coaching 2" }, moves: {} });
  is("Sam, who may only see Workshops, renames Coaching: the deal stays where it was", [renamed.status, JSON.parse(String((await redisPipeline([["HGET", dealsKey, "orphan0001"]]))[0])).stage], [200, "orph01"]);
  const byOwner = await crm(owner, { action: "pipeline", pipeline: { ...coaching, name: "Coaching" }, moves: {} });
  is("the owner's change still brings it back to the first pipeline's first open stage", [byOwner.status, JSON.parse(String((await redisPipeline([["HGET", dealsKey, "orphan0001"]]))[0])).stage], [200, "wnew01"]);

  part("A record holding anything that is not a restriction opens nothing");
  for (const raw of [{ wkshp1: "VIEW" }, { WKSHP1: "none" }, { wkshp1: "view", other: "none" }]) {
    await redisPipeline([["HSET", `nl:crm:pacc:${statsId}`, "sam@example.com", JSON.stringify(raw)]]);
    is(`${JSON.stringify(raw)} is read as unreadable, never as no restriction`, [await readPipelineAccess(statsId, "sam@example.com"), (await crm("sam@example.com", { action: "deal", deal: { title: "T", email: "", cents: 1, stage: "cnew01", note: "" } })).status], [null, 403]);
  }
  await redisPipeline([["HSET", `nl:crm:pacc:${statsId}`, "sam@example.com", JSON.stringify({ wkshp1: "view" })]]);
  is("a record as written still reads as written", [await readPipelineAccess(statsId, "sam@example.com"), (await readAllPipelineAccess(statsId))["sam@example.com"]], [{ wkshp1: "view" }, { wkshp1: "view" }]);

  part("Only pipeline ids are named");
  await writePipelineAccess(statsId, "sam@example.com", {}, store);
  const linesBefore = (await readLog(store.sid)).length;
  const proto = await pacc('{"email":"sam@example.com","choices":{"__proto__":"view"}}');
  is("\"__proto__\" is not a pipeline: refused, nothing written, nothing logged", [proto.status, proto.body.error, await readPipelineAccess(statsId, "sam@example.com"), (await readLog(store.sid)).length - linesBefore], [400, "invalid", {}, 0]);
  is("nor with a real one beside it, nor one at a time, nor constructor", [(await pacc('{"email":"sam@example.com","choices":{"__proto__":"view","wkshp1":"none"}}')).status, (await pacc({ email: "sam@example.com", pipeline: "__proto__", access: "view" })).status, (await pacc({ email: "sam@example.com", choices: { constructor: "view" } })).status], [400, 400, 400]);

  part("Who cannot be restricted is told why");
  // Ivy is invited and has not joined (written as the team record keeps it: no email is sent in a test).
  const teamNow = JSON.parse(String((await redisPipeline([["GET", `nl:team:${store.sid}`]]))[0]));
  await redisPipeline([["SET", `nl:team:${store.sid}`, JSON.stringify({ ...teamNow, invites: [{ id: "0123456789abcdef", email: "ivy@example.com", role: "support", createdAt: new Date().toISOString(), expiresAt: Math.floor(Date.now() / 1000) + 3600 }] })]]);
  is("(Ivy is invited)", (await readTeam(store.sid)).invites.map((i) => i.email), ["ivy@example.com"]);
  const invited = await pacc({ email: "ivy@example.com", choices: { wkshp1: "none" } });
  is("someone invited who has not joined", [invited.status, invited.body.error, invited.body.message], [400, "invited", "This person has not joined your team yet. You can choose their access once they accept the invitation."]);
  const self = await pacc({ email: owner, choices: { wkshp1: "none" } });
  is("the owner", [self.status, self.body.error, self.body.message], [400, "owner", "You always see and change every pipeline of your store, so there is nothing to restrict."]);
  const nobody = await pacc({ choices: { wkshp1: "none" } });
  is("nobody named", [nobody.status, nobody.body.error, nobody.body.message], [400, "invalid", "No teammate was named. Reload the page and try again."]);
  is("someone not on the team at all is still told to reload", (await pacc({ email: "x@example.com", choices: { wkshp1: "none" } })).status, 404);

  part("A new deal with no stage is refused for that");
  const noStage = await crm("sam@example.com", { action: "deal", deal: { title: "T", email: "", cents: 1, note: "" } });
  is("from a Support person who sees every pipeline: the stage is missing, not access", [noStage.status, noStage.body.error], [400, "stage"]);
  is("as it is for the owner", (await crm(owner, { action: "deal", deal: { title: "T", email: "", cents: 1, note: "" } })).body.error, "stage");
  await writePipelineAccess(statsId, "sam@example.com", { coach1: "none" }, store);
  is("an unknown stage, from someone who does not see every pipeline, is refused as access (it never tells which stages exist)", (await crm("sam@example.com", { action: "deal", deal: { title: "T", email: "", cents: 1, stage: "zzzz99", note: "" } })).status, 403);

  part("A Save from a page opened before another change");
  await writePipelineAccess(statsId, "sam@example.com", {}, store);
  is("(tab A, opened when Sam had no restriction, saves Workshops: only see)", (await pacc({ email: "sam@example.com", choices: { wkshp1: "view", coach1: "edit" }, was: {} })).status, 200);
  const stale = await pacc({ email: "sam@example.com", choices: { wkshp1: "edit", coach1: "none" }, was: {} });
  is("tab B, opened at the same time, is refused and told to reload; tab A's choice is kept", [stale.status, stale.body.error, stale.body.message, await readPipelineAccess(statsId, "sam@example.com")], [409, "changed", "This person's access was changed somewhere else since you opened this page. Reload the page to see it, then choose again.", { wkshp1: "view" }]);
  is("after reloading, it saves", (await pacc({ email: "sam@example.com", choices: { wkshp1: "edit", coach1: "none" }, was: { wkshp1: "view" } })).body.access, { coach1: "none" });
  is("a record that could not be read is sent as null and must still be unreadable", [(await pacc({ email: "sam@example.com", choices: { wkshp1: "view" }, was: null })).status, (await pacc({ email: "sam@example.com", choices: { wkshp1: "view" }, was: { wkshp1: "VIEW" } })).status], [409, 400]);
  const editorCode = readFileSync("components/pipeline-access-editor.tsx", "utf8");
  is("the team page sends the record it read with every Save", editorCode.includes("body: JSON.stringify({ email, choices, was })"), true);

  part("The activity log says what changed, pipeline by pipeline");
  await pacc({ email: "sam@example.com", choices: { wkshp1: "none", coach1: "none" } });
  const line = (await readLog(store.sid))[0]?.what;
  is("only the pipeline that changed, with what it was", line, "Set sam@example.com's pipeline access. Workshops: no access (was can change)");
  await pacc({ email: "sam@example.com", choices: { wkshp1: "none", coach1: "none" } });
  is("a Save that changes nothing says so", (await readLog(store.sid))[0]?.what, "Saved sam@example.com's pipeline access with no change");

  part("Moving a sign-in");
  const roomOf = async () => Number((await redisPipeline([["HGET", dataKey(store)!, "crm:pacc"]]))[0] ?? 0);
  await putMember(store, "tom@example.com", "support");
  await writePipelineAccess(statsId, "tom@example.com", {}, store);
  await redisPipeline([["HSET", `nl:crm:pacc:${statsId}`, "zed@example.com", JSON.stringify({ wkshp1: "none" })]]);
  await moveMemberships("tom@example.com", "zed@example.com");
  is("someone with no restriction moves to an address with an old one: the old one does not follow them", [(await readTeam(store.sid)).members.some((m) => m.email === "zed@example.com"), await readPipelineAccess(statsId, "zed@example.com")], [true, {}]);
  await redisPipeline([["HSET", `nl:crm:pacc:${statsId}`, "yan@example.com", JSON.stringify({ wkshp1: "none", coach1: "view" })]]);
  await redisPipeline([["HDEL", `nl:crm:pacc:${statsId}`, "zed@example.com"]]);
  const oldWeight = dataBytes(["yan@example.com", JSON.stringify({ wkshp1: "none", coach1: "view" })], 1);
  await redisPipeline([["HSET", dataKey(store)!, "crm:pacc", String(oldWeight)]]);
  await redisPipeline([["HSET", `nl:crm:pacc:${statsId}`, "zed@example.com", JSON.stringify({ wkshp1: "view" })]]);
  await copyPipelineAccess(store, "zed@example.com", "yan@example.com");
  is("a copy over an old field counts only the difference", [await readPipelineAccess(statsId, "yan@example.com"), (await roomOf()) - oldWeight], [{ wkshp1: "view" }, dataBytes(["yan@example.com", JSON.stringify({ wkshp1: "view" })], 1) - oldWeight]);
  await redisPipeline([["HSET", dataKey(store)!, "crm:pacc", String(dataBytes(["yan@example.com", JSON.stringify({ wkshp1: "view" })], 1))]]);
  await redisPipeline([["HDEL", `nl:crm:pacc:${statsId}`, "zed@example.com"]]);
  await copyPipelineAccess(store, "zed@example.com", "yan@example.com");
  is("a copy of no restriction deletes the old field and gives its room back", [(await redisPipeline([["HGET", `nl:crm:pacc:${statsId}`, "yan@example.com"]]))[0], await roomOf()], [null, 0]);
  const teamCode = readFileSync("lib/team.ts", "utf8");
  const move = teamCode.slice(teamCode.indexOf("export async function moveMemberships"));
  is("the old address's restrictions are forgotten under the team's lock, after the team names the new one", move.indexOf("await forgetPipelineAccess(store, before)") > move.indexOf("await saveTeam(sid,") && move.indexOf("await forgetPipelineAccess(store, before)") < move.indexOf("if (!role) continue;"), true);

  part("A form response already made into a deal");
  const formCode = readFileSync("app/api/store/form-opportunity/route.ts", "utf8");
  const existingAt = formCode.indexOf('state: "existing", deal: existing');
  is("is shown only to someone who may see its pipeline", existingAt > 0 && formCode.lastIndexOf('accessOf(guarded.role, await readPipelineAccess(store.statsId, guarded.email), pipeline) === "none"', existingAt) > 0, true);

  done();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
