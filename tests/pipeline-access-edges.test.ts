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

  part("Round 4: a hidden pipeline's name is never told by a refusal");
  // Sam: no access to Coaching; Workshops as kept from above.
  await writePipelineAccess(statsId, "sam@example.com", { coach1: "none" }, store);
  const third = (id: string, name: string, p: string) => ({ id, name, stages: [{ id: `${p}new1`, name: "New", kind: "open" }, { id: `${p}won1`, name: "Won", kind: "won" }, { id: `${p}lst1`, name: "Lost", kind: "lost" }] });
  const sameAsHidden = await crm("sam@example.com", { action: "pipeline", pipeline: third("sams01", "coaching", "sa"), moves: {} });
  const unused = await crm("sam@example.com", { action: "pipeline", pipeline: third("sams02", "Brand deals", "sb"), moves: {} });
  is("a name a hidden pipeline has answers as a name nobody has", [sameAsHidden.status, unused.status, sameAsHidden.body.pipelines?.map((p) => p.id).includes("coach1")], [200, 200, false]);
  is("both are kept, told apart by their ids, and the store still reads", (await readPipelines(statsId)).filter((p) => p.name.toLowerCase() === "coaching").map((p) => p.id), ["coach1", "sams01"]);
  is("a name a pipeline they see has is still refused", (await crm("sam@example.com", { action: "pipeline", pipeline: { ...third("sams02", "WORKSHOPS", "sb") }, moves: {} })).body.error, "pipelines");
  is("and for the owner, who sees every pipeline, a name twice is still refused", (await crm(owner, { action: "pipeline", pipeline: { ...coaching, name: "Brand Deals" }, moves: {} })).body.error, "pipelines");

  part("Round 4: an id that is not there answers as one they may not change");
  is("a deal, and a pipeline to remove, that are not there", [(await crm("sam@example.com", { action: "deal", deal: { id: "zzzzzzzzzz", title: "T", email: "", cents: 1, stage: "wnew01", note: "" } })).status, (await crm("sam@example.com", { action: "unpipeline", id: "zzzz99", moveTo: "" })).status, (await crm("sam@example.com", { action: "unpipeline", id: "coach1", moveTo: "" })).status], [403, 403, 403]);
  is("the owner is still told it is gone", (await crm(owner, { action: "deal", deal: { id: "zzzzzzzzzz", title: "T", email: "", cents: 1, stage: "wnew01", note: "" } })).status, 404);

  part("Round 4: a deal changed between the check and the write is never written over");
  await writePipelineAccess(statsId, "sam@example.com", { coach1: "none" }, store);
  const mine = (await crm(owner, { action: "deal", deal: { title: "Mine", email: "", cents: 1, stage: "wnew01", note: "" } })).body.deal!.id;
  const moved = JSON.stringify({ ...JSON.parse(String((await redisPipeline([["HGET", dealsKey, mine]]))[0])), stage: "cnew01" });
  const real = redis.pipeline.bind(redis);
  let raced = false;
  redis.pipeline = (async (commands: (string | number)[][]) => {
    // The owner moves the deal into Coaching, which Sam may not see, just before Sam's change is written.
    if (!raced && commands.some((c) => c[0] === "EVAL" && String(c[1]).startsWith("-- marktmorgen:crm-deal-") && c[4] === mine)) {
      raced = true;
      await real([["HSET", dealsKey, mine, moved]]);
    }
    return real(commands);
  }) as typeof redis.pipeline;
  const late = await crm("sam@example.com", { action: "deal", deal: { id: mine, title: "Renamed by Sam", email: "", cents: 1, stage: "wnew01", note: "" } });
  redis.pipeline = real;
  is("refused as changed meanwhile, and the owner's move stays", [late.status, late.body.error, (await redisPipeline([["HGET", dealsKey, mine]]))[0] === moved], [409, "deal_conflict", true]);
  is("a change with nothing in between still saves", (await crm(owner, { action: "deal", deal: { id: mine, title: "Again", email: "", cents: 1, stage: "cnew01", note: "" } })).status, 200);

  part("Round 4: a pipelines record that cannot be read changes no access");
  await writePipelineAccess(statsId, "sam@example.com", { coach1: "none", wkshp1: "view" }, store);
  const pipesKey = `nl:crm:pipes:${statsId}`;
  const goodPipes = (await redisPipeline([["GET", pipesKey]]))[0];
  await redisPipeline([["SET", pipesKey, "{broken"]]);
  const unread = await pacc({ email: "sam@example.com", choices: { sales0: "view" } });
  await redisPipeline([["SET", pipesKey, String(goodPipes)]]);
  is("refused, and every restriction kept", [unread.status, unread.body.error, await readPipelineAccess(statsId, "sam@example.com")], [503, "unavailable", { coach1: "none", wkshp1: "view" }]);
  const pageCode = readFileSync("app/studio/team/page.tsx", "utf8");
  is("the team page reads the pipelines the same way", pageCode.includes("readPipelinesExact(store.statsId).catch(() => null)"), true);

  part("Round 4: a copied record's room is taken before it is written");
  await redisPipeline([["HSET", `nl:crm:pacc:${statsId}`, "una@example.com", JSON.stringify({ coach1: "none" })], ["HDEL", `nl:crm:pacc:${statsId}`, "uli@example.com"]]);
  redis.pipeline = (async (commands: (string | number)[][]) => {
    if (commands.some((c) => c[0] === "EVAL" && String(c[1]).startsWith("-- marktmorgen:store-data:"))) throw new Error("data room unavailable");
    return real(commands);
  }) as typeof redis.pipeline;
  let refused = false;
  await copyPipelineAccess(store, "una@example.com", "uli@example.com").catch(() => { refused = true; });
  redis.pipeline = real;
  is("a room that cannot be counted refuses the copy, and nothing is written uncounted", [refused, (await redisPipeline([["HGET", `nl:crm:pacc:${statsId}`, "uli@example.com"]]))[0]], [true, null]);

  part("Round 5: two pipelines with one name");
  // From above: Coaching (coach1, the owner's) and Sam's "coaching" (sams01) share a name.
  const kept = (await readPipelines(statsId)).find((p) => p.id === "coach1")!;
  const stagesKept = await crm(owner, { action: "pipeline", pipeline: { ...kept, stages: [...kept.stages, { id: "cmid01", name: "Talking", kind: "open" }] }, moves: {} });
  is("the owner still changes either one's stages, its name kept", stagesKept.status, 200);
  await pacc({ email: "sam@example.com", choices: { coach1: "view", sams01: "edit" } });
  is("the team's log tells them apart", (await readLog(store.sid))[0]?.what, "Set sam@example.com's pipeline access. Coaching: can only see (was no access)");
  await pacc({ email: "sam@example.com", choices: { coach1: "view", sams01: "none" } });
  is("and names the later one with its number", (await readLog(store.sid))[0]?.what, "Set sam@example.com's pipeline access. coaching (2): no access (was can change)");

  part("Round 5: an access record that cannot be read is a known refusal");
  redis.pipeline = (async (commands: (string | number)[][]) => {
    if (commands.some((c) => c[0] === "HGET" && String(c[1]).startsWith("nl:crm:pacc:"))) throw new Error("down");
    return real(commands);
  }) as typeof redis.pipeline;
  const unreadAccess = await crm("sam@example.com", { action: "deal", deal: { title: "T", email: "", cents: 1, stage: "wnew01", note: "" } });
  redis.pipeline = real;
  is("nothing was written, and the board is told so, never that it may have happened", [unreadAccess.status, unreadAccess.body.error], [503, "crm_schema_read_unavailable"]);

  part("Round 5: a removal checked against one deal never removes a changed one");
  await writePipelineAccess(statsId, "sam@example.com", { coach1: "none" }, store);
  const doomed = (await crm(owner, { action: "deal", deal: { title: "Doomed", email: "", cents: 1, stage: "wnew01", note: "" } })).body.deal!.id;
  const hiddenNow = JSON.stringify({ ...JSON.parse(String((await redisPipeline([["HGET", dealsKey, doomed]]))[0])), stage: "cnew01" });
  let movedFirst = false;
  redis.pipeline = (async (commands: (string | number)[][]) => {
    // The owner moves it into Coaching, which Sam may not see, between Sam's check and the removal.
    if (!movedFirst && commands.some((c) => (c[0] === "HDEL" && c[1] === dealsKey) || (c[0] === "EVAL" && String(c[1]).startsWith("-- marktmorgen:crm-deal-drop:")))) {
      movedFirst = true;
      await real([["HSET", dealsKey, doomed, hiddenNow]]);
    }
    return real(commands);
  }) as typeof redis.pipeline;
  const removal = await crm("sam@example.com", { action: "undeal", id: doomed });
  redis.pipeline = real;
  is("refused as changed meanwhile, and the deal is still there", [removal.status, removal.body.error, (await redisPipeline([["HGET", dealsKey, doomed]]))[0] === hiddenNow], [409, "deal_conflict", true]);
  is("a removal of a deal they may change, with nothing in between, still works", [(await crm("sam@example.com", { action: "undeal", id: (await crm(owner, { action: "deal", deal: { title: "Gone", email: "", cents: 1, stage: "wnew01", note: "" } })).body.deal!.id })).status], [200]);

  part("Round 5: a refused save keeps the room it took when what is saved cannot be read");
  const slotOf = async (id: string) => (await redisPipeline([["HGET", dataKey(store)!, `dl:${id}`]]))[0];
  const contested = (await crm(owner, { action: "deal", deal: { title: "Contested", email: "", cents: 1, stage: "wnew01", note: "" } })).body.deal!.id;
  const changedBy = JSON.stringify({ ...JSON.parse(String((await redisPipeline([["HGET", dealsKey, contested]]))[0])), title: "Changed by someone else" });
  let phase = 0;
  redis.pipeline = (async (commands: (string | number)[][]) => {
    if (phase === 0 && commands.some((c) => c[0] === "EVAL" && String(c[1]).startsWith("-- marktmorgen:crm-deal-") && c[4] === contested)) {
      phase = 1;
      await real([["HSET", dealsKey, contested, changedBy]]);
      return real(commands);
    }
    if (phase === 1 && commands.some((c) => c[0] === "HGET" && c[1] === dealsKey && c[2] === contested)) throw new Error("down");
    return real(commands);
  }) as typeof redis.pipeline;
  const lost = await crm("sam@example.com", { action: "deal", deal: { id: contested, title: "A much longer title written by Sam", email: "", cents: 1, stage: "wnew01", note: "" } });
  redis.pipeline = real;
  is("refused as changed meanwhile, and the room is never set to nothing", [lost.status, Number(await slotOf(contested)) > 0], [409, true]);

  part("Round 5: a full room's count that cannot be made refuses the copy");
  await redisPipeline([["HSET", `nl:crm:pacc:${statsId}`, "una@example.com", JSON.stringify({ coach1: "none" })], ["HDEL", `nl:crm:pacc:${statsId}`, "uli@example.com"]]);
  let counts = 0;
  redis.pipeline = (async (commands: (string | number)[][]) => {
    if (commands.some((c) => c[0] === "EVAL" && String(c[1]).startsWith("-- marktmorgen:store-data:"))) {
      counts += 1;
      // The room is full at first; the forced count then cannot be made.
      if (counts === 1) return [[0, 999_999_999]];
      throw new Error("data room unavailable");
    }
    return real(commands);
  }) as typeof redis.pipeline;
  let forcedRefused = false;
  await copyPipelineAccess(store, "una@example.com", "uli@example.com").catch(() => { forcedRefused = true; });
  redis.pipeline = real;
  is("nothing is written uncounted", [forcedRefused, (await redisPipeline([["HGET", `nl:crm:pacc:${statsId}`, "uli@example.com"]]))[0]], [true, null]);

  part("Round 5: a form response made into a deal a moment ago by someone else");
  const formRoute = readFileSync("app/api/store/form-opportunity/route.ts", "utf8");
  is("is shown only to someone who may see its pipeline, as one made before", formRoute.includes('if (result.state === "existing" && (await hidden(result.deal.stage))) return noAccess();'), true);

  done();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
