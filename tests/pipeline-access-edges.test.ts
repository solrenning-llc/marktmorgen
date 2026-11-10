/**
 * 639 [GL7](7): edge cases of each teammate's pipeline access found in
 * review, through the real routes, session and store
 * (app/api/store/crm, app/api/store/pipeline-access, lib/crm.ts,
 * lib/pipeline-access.ts, lib/team.ts, components/pipeline-access-editor.tsx).
 * Each check here failed before its fix.
 */
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { NextRequest } from "next/server";
import { POST as CRM } from "@/app/api/store/crm/route";
import { POST as PACC } from "@/app/api/store/pipeline-access/route";
import { SESSION_COOKIE, openSession } from "@/lib/auth";
import { DROP_CRM_DEAL, dealVersion, readPipelines } from "@/lib/crm";
import { copyPipelineAccess, readAllPipelineAccess, readPipelineAccess, undoPipelineAccessCopy, writePipelineAccess } from "@/lib/pipeline-access";
import { redisPipeline } from "@/lib/redis";
import { claimHandle, ensureStatsId, ensureStoreId, setStripeAccount, setSubscription, storeForEmail } from "@/lib/store";
import { dataKey } from "@/lib/store-data";
import { dataBytes } from "@/lib/store-data-rules";
import { LOG_LINE_BYTES, logTeam, moveMemberships, putMember, readLog, readTeam } from "@/lib/team";
import { type AccessLog, accessLogNamer, accessLogWords, parseAccessLog } from "@/lib/pipeline-access-rules";
import { MAX_PIPELINE_NAME, PIPELINES_BY_TIER } from "@/lib/crm-rules";
import { store as redis } from "./redis-stub";
import { paidPeriod } from "./billing-period-fixture";
import { done, is, part } from "./check";

type Reply = { ok?: boolean; error?: string; message?: string; access?: Record<string, string>; deal?: { id: string }; pipelines?: { id: string }[] };

/**
 * The Lua that removes a deal only while it is the record read (DROP_CRM_DEAL in lib/crm.ts), as Redis runs it,
 * for the in-memory store this test uses: its own shim, so lib/redis-memory.ts stays as it is on main.
 */
function runDealDropLikeRedis(): void {
  const plain = redis.pipeline.bind(redis);
  const isDrop = (c: (string | number)[]) => c[0] === "EVAL" && String(c[1]) === DROP_CRM_DEAL && c[2] === 1 && c.length === 6;
  redis.pipeline = (async (commands: (string | number)[][]) => {
    if (!commands.some(isDrop)) return plain(commands);
    const out: unknown[] = [];
    for (const c of commands) {
      if (!isDrop(c)) { out.push(...(await plain([c]))); continue; }
      const [, , , key, field, expected] = c;
      const [current] = await plain([["HGET", key, field]]);
      if (current === null || current === undefined) out.push(0);
      else if (current !== expected) out.push(-1);
      else { await plain([["HDEL", key, field]]); out.push(1); }
    }
    return out;
  }) as typeof redis.pipeline;
}

async function main(): Promise<void> {
  redis.clear();
  runDealDropLikeRedis();
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
  // The version of a deal as it is kept now, as the board sends it with an edit (635 [GL3]).
  const versionOf = async (id: string) => dealVersion(String((await redisPipeline([["HGET", dealsKey, id]]))[0]));
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
  const linesBefore = (await readLog(store.sid))!.length;
  const proto = await pacc('{"email":"sam@example.com","choices":{"__proto__":"view"}}');
  is("\"__proto__\" is not a pipeline: refused, nothing written, nothing logged", [proto.status, proto.body.error, await readPipelineAccess(statsId, "sam@example.com"), (await readLog(store.sid))!.length - linesBefore], [400, "invalid", {}, 0]);
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
  const line = (await readLog(store.sid))![0]?.what;
  is("only the pipeline that changed, with what it was", line, "Set sam@example.com's pipeline access. Workshops: no access (was can change)");
  await pacc({ email: "sam@example.com", choices: { wkshp1: "none", coach1: "none" } });
  is("a Save that changes nothing says so", (await readLog(store.sid))![0]?.what, "Saved sam@example.com's pipeline access with no change");

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

  part("A move that fails after the copy puts the new address back as it was (Codex N, #2036)");
  const paccKey = `nl:crm:pacc:${statsId}`;
  const setRoom = async (bytes: number) => { await redisPipeline([["HSET", dataKey(store)!, "crm:pacc", String(bytes)]]); };
  const yanNow = async () => (await redisPipeline([["HGET", paccKey, "yan@example.com"]]))[0];
  const carried = JSON.stringify({ wkshp1: "none" });
  const earlier = JSON.stringify({ coach1: "view", wkshp1: "edit" });
  const earlierWeight = dataBytes(["yan@example.com", earlier], 1);
  await redisPipeline([["HDEL", paccKey, "yan@example.com"], ["HSET", paccKey, "zed@example.com", carried]]);
  await setRoom(0);
  await undoPipelineAccessCopy(store, "yan@example.com", await copyPipelineAccess(store, "zed@example.com", "yan@example.com"));
  is("nothing there before: nothing after, and the copy's room given back", [await yanNow(), await roomOf()], [null, 0]);
  await redisPipeline([["HSET", paccKey, "yan@example.com", earlier]]);
  await setRoom(earlierWeight);
  await undoPipelineAccessCopy(store, "yan@example.com", await copyPipelineAccess(store, "zed@example.com", "yan@example.com"));
  is("an earlier record there: the same record after, its room as it was", [await yanNow(), await roomOf()], [earlier, earlierWeight]);
  await redisPipeline([["HDEL", paccKey, "zed@example.com"], ["HSET", paccKey, "yan@example.com", earlier]]);
  await setRoom(earlierWeight);
  await undoPipelineAccessCopy(store, "yan@example.com", await copyPipelineAccess(store, "zed@example.com", "yan@example.com"));
  is("no restriction to carry, the earlier record cleared by the copy: it comes back, with its room", [await yanNow(), await roomOf()], [earlier, earlierWeight]);
  await redisPipeline([["HDEL", paccKey, "yan@example.com"]]);
  await setRoom(0);
  const teamCode = readFileSync("lib/team.ts", "utf8");
  const move = teamCode.slice(teamCode.indexOf("export async function moveMemberships"));
  is("the old address's restrictions are forgotten under the team's lock, after the team names the new one", move.indexOf("await forgetPipelineAccess(store, before)") > move.indexOf("await saveTeam(sid,") && move.indexOf("await forgetPipelineAccess(store, before)") < move.indexOf("if (!role) continue;"), true);

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
  const mineVersion = await versionOf(mine);
  const late = await crm("sam@example.com", { action: "deal", version: mineVersion, deal: { id: mine, title: "Renamed by Sam", email: "", cents: 1, stage: "wnew01", note: "" } });
  redis.pipeline = real;
  // The edit's conflict (635 [GL3]), without the deal as it is now: it moved where Sam may not see it.
  is("refused as changed meanwhile, and the owner's move stays", [raced, late.status, late.body.error, "current" in late.body, (await redisPipeline([["HGET", dealsKey, mine]]))[0] === moved], [true, 409, "crm_conflict", false, true]);
  is("a change with nothing in between still saves", (await crm(owner, { action: "deal", version: await versionOf(mine), deal: { id: mine, title: "Again", email: "", cents: 1, stage: "cnew01", note: "" } })).status, 200);

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
  is("the team's log tells them apart", (await readLog(store.sid))![0]?.what, "Set sam@example.com's pipeline access. Coaching: can only see (was no access)");
  await pacc({ email: "sam@example.com", choices: { coach1: "view", sams01: "none" } });
  const twinLine = (await readLog(store.sid))![0]!;
  is("and, on the team page, names the later one with its number", accessLogWords(twinLine.access!, accessLogNamer(await readPipelines(statsId))), "Set sam@example.com's pipeline access. coaching (2): no access (was can change)");

  part("Round 5: an access record that cannot be read is a known refusal");
  redis.pipeline = (async (commands: (string | number)[][]) => {
    if (commands.some((c) => c[0] === "HGET" && String(c[1]).startsWith("nl:crm:pacc:"))) throw new Error("down");
    return real(commands);
  }) as typeof redis.pipeline;
  const unreadAccess = await crm("sam@example.com", { action: "deal", deal: { title: "T", email: "", cents: 1, stage: "wnew01", note: "" } });
  redis.pipeline = real;
  // main's #2989 answers an unread access record 503 "unavailable", a known refusal (lib/crm-response.ts REFUSALS).
  is("nothing was written, and the board is told so, never that it may have happened", [unreadAccess.status, unreadAccess.body.error], [503, "unavailable"]);

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
  const contestedVersion = await versionOf(contested);
  const lost = await crm("sam@example.com", { action: "deal", version: contestedVersion, deal: { id: contested, title: "A much longer title written by Sam", email: "", cents: 1, stage: "wnew01", note: "" } });
  redis.pipeline = real;
  // The write's own answer measures what is kept now (MOVE_CRM_DEAL v2), so the room is the record's as it is now;
  // the deal as it is now cannot be read back for the board, which is told so (nothing was written).
  is("refused as changed meanwhile, and the room is never set to nothing", [phase, lost.status, lost.body.error, Number(await slotOf(contested)) > 0], [1, 503, "crm_deal_read_unavailable", true]);

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

  part("Round 6: the log names each pipeline as it is named when the log is read");
  is("kept by pipeline id, with the name it had", [twinLine.what, twinLine.access], ["Set sam@example.com's pipeline access. coaching: no access (was can change)", { email: "sam@example.com", one: false, changes: [{ id: "sams01", name: "coaching", now: "none", was: "edit" }] }]);
  const firstLine = (await readLog(store.sid))!.find((l) => l.access?.changes.some((c) => c.id === "coach1"))!;
  is("(the owner removes the first Coaching)", (await crm(owner, { action: "unpipeline", id: "coach1", moveTo: "wnew01" })).status, 200);
  const namer = accessLogNamer(await readPipelines(statsId));
  is("the one left is named as it is now, never by a number that pointed at it before; the one removed is said as removed", [accessLogWords(twinLine.access!, namer), accessLogWords(firstLine.access!, namer)], ["Set sam@example.com's pipeline access. coaching: no access (was can change)", "Set sam@example.com's pipeline access. Coaching (since removed): can only see (was no access)"]);
  is("with the pipelines unreadable, by the name each had", accessLogWords(twinLine.access!, accessLogNamer(null)), "Set sam@example.com's pipeline access. coaching: no access (was can change)");
  is("the team page words the line from it", readFileSync("app/studio/team/page.tsx", "utf8").includes("{line.access ? accessLogWords(line.access, nameOf) : line.what}"), true);

  part("Round 6: a deal gone between the check and its removal");
  await writePipelineAccess(statsId, "sam@example.com", {}, store);
  const vanishing = (await crm(owner, { action: "deal", deal: { title: "Vanishing", email: "", cents: 1, stage: "wnew01", note: "" } })).body.deal!.id;
  let goneFirst = false;
  redis.pipeline = (async (commands: (string | number)[][]) => {
    if (!goneFirst && commands.some((c) => c[0] === "EVAL" && String(c[1]).startsWith("-- marktmorgen:crm-deal-drop:"))) {
      goneFirst = true;
      await real([["HDEL", dealsKey, vanishing]]);
    }
    return real(commands);
  }) as typeof redis.pipeline;
  const vanished = await crm("sam@example.com", { action: "undeal", id: vanishing });
  redis.pipeline = real;
  is("is said as gone, their access having been checked", [vanished.status, vanished.body.error], [404, "unknown"]);
  is("and a removal refused as changed says nothing was removed", readFileSync("components/deals-board.tsx", "utf8").includes('answer.error === "deal_conflict" && body.action === "undeal" ? "Somebody else changed this deal a moment ago, so nothing was removed.'), true);

  part("Round 7: every log line stays within what the data registry counts");
  const logKeyOf = `nl:team:log:${store.sid}`;
  const rawNewest = async () => String(((await redisPipeline([["LRANGE", logKeyOf, 0, 0]]))[0] as string[])[0]);
  // The largest line a Save can make: the longest address, every pipeline of the largest plan with the longest name, in letters that take three bytes each.
  const longest = `${"a".repeat(64)}@${"b".repeat(185)}.com`;
  const bigName = "\u20AC".repeat(MAX_PIPELINE_NAME);
  const worst: AccessLog = { email: longest, one: false, changes: Array.from({ length: PIPELINES_BY_TIER.scale }, (_, i) => ({ id: `pipe${String(i).padStart(2, "0")}`, name: bigName, now: "none", was: "edit" })) };
  await logTeam(store.sid, { who: longest, role: "owner", what: accessLogWords(worst, (c) => c.name), access: worst });
  const worstRaw = await rawNewest();
  is("the largest line fits: its details are dropped first, then its words shortened", [Buffer.byteLength(worstRaw, "utf8") <= LOG_LINE_BYTES, Object.hasOwn(JSON.parse(worstRaw), "access"), (await readLog(store.sid))![0].what.startsWith("Set ")], [true, false, true]);
  const many: AccessLog = { ...worst, email: "sam@example.com", changes: worst.changes.map((c) => ({ ...c, name: "P".repeat(MAX_PIPELINE_NAME) })) };
  await logTeam(store.sid, { who: owner, role: "owner", what: accessLogWords(many, (c) => c.name), access: many });
  const manyRaw = await rawNewest();
  is("with usual addresses and names, every pipeline at once: its details dropped, its words (which name the pipelines) kept whole", [Buffer.byteLength(manyRaw, "utf8") <= LOG_LINE_BYTES, Object.hasOwn(JSON.parse(manyRaw), "access"), (await readLog(store.sid))![0].what === accessLogWords(many, (c) => c.name).slice(0, 200)], [true, false, true]);
  const small: AccessLog = { email: "sam@example.com", one: true, changes: [{ id: "wkshp1", name: "Workshops", now: "view", was: "edit" }] };
  await logTeam(store.sid, { who: owner, role: "owner", what: accessLogWords(small, (c) => c.name), access: small });
  is("a usual one keeps its details, so the team page names its pipeline as it is when shown", [Buffer.byteLength(await rawNewest(), "utf8") <= LOG_LINE_BYTES, (await readLog(store.sid))![0].access], [true, small]);
  await logTeam(store.sid, { who: longest, role: "owner", what: "\u20AC".repeat(200) });
  is("and any line at all, its words shortened when they must be", Buffer.byteLength(await rawNewest(), "utf8") <= LOG_LINE_BYTES, true);
  is("the registry counts the log from the same bound", readFileSync("tests/store-data-registry.ts", "utf8").includes("capped(LOG_LINES * (LOG_LINE_BYTES + 64)") && LOG_LINE_BYTES + 64 <= 512, true);

  part("Round 7: a logged access change names a real address");
  is("anything else is not read as one, and the line's own words are shown", [parseAccessLog({ email: "not an address", one: true, changes: [] }), parseAccessLog({ email: "sam@example.com", one: true, changes: [] })], [null, { email: "sam@example.com", one: true, changes: [] }]);

  part("Round 8: the older stages request writes only the pipeline it checked");
  const lineUp = await readPipelines(statsId);
  is("(two pipelines or more to reorder)", lineUp.length >= 2, true);
  const [checked, other] = lineUp;
  await writePipelineAccess(statsId, "sam@example.com", { [other.id]: "none" }, store);
  const swapped = JSON.stringify([other, checked, ...lineUp.slice(2)]);
  const freshStages = (prefix: string) => [{ id: `${prefix}new01`, name: "Taken", kind: "open" }, { id: `${prefix}won01`, name: "Won", kind: "won" }, { id: `${prefix}lst01`, name: "Lost", kind: "lost" }];
  // The owner reorders the pipelines, putting one Sam may not see first, after the route checked the first one and before the write reads them.
  const reorderOnSecondRead = () => {
    let reads = 0;
    redis.pipeline = (async (commands: (string | number)[][]) => {
      if (commands.some((c) => c[0] === "GET" && c[1] === pipesKey) && ++reads === 2) await real([["SET", pipesKey, swapped]]);
      return real(commands);
    }) as typeof redis.pipeline;
  };
  reorderOnSecondRead();
  const racedStages = await crm("sam@example.com", { action: "stages", stages: freshStages("q") });
  redis.pipeline = real;
  const afterRace = await readPipelines(statsId);
  is("Sam's stages are refused as changed meanwhile, and the pipeline now first keeps its own", [racedStages.status, racedStages.body.error, afterRace[0].id, JSON.stringify(afterRace[0].stages) === JSON.stringify(other.stages), JSON.stringify(afterRace[1].stages) === JSON.stringify(checked.stages)], [409, "crm_conflict", other.id, true, true]);
  // The owner's own request is held to the pipeline it read the same way.
  await redisPipeline([["SET", pipesKey, JSON.stringify(lineUp)]]);
  reorderOnSecondRead();
  const ownerRaced = await crm(owner, { action: "stages", stages: freshStages("r") });
  redis.pipeline = real;
  is("so is the owner's: nothing is written into a pipeline that was not the one read as first", [ownerRaced.status, ownerRaced.body.error, JSON.stringify((await readPipelines(statsId))[0].stages) === JSON.stringify(other.stages)], [409, "crm_conflict", true]);
  await redisPipeline([["SET", pipesKey, JSON.stringify(lineUp)]]);
  const calm = await crm("sam@example.com", { action: "stages", stages: [...checked.stages] });
  is("with nothing in between, the first pipeline's stages are saved", [calm.status, (await readPipelines(statsId))[0].id], [200, checked.id]);
  is("the route checks, and writeStages writes, the same pipeline", readFileSync("app/api/store/crm/route.ts", "utf8").includes("await writeStages(statsId, stages, store, first)"), true);

  part("Round 8: an access record that cannot be read adds no pipeline either");
  // One pipeline only, so the plan has room for another and only the access is in the way.
  await redisPipeline([["SET", pipesKey, JSON.stringify([checked])], ["HSET", `nl:crm:pacc:${statsId}`, "sam@example.com", "{not json"]]);
  const pipesBefore = String((await redisPipeline([["GET", pipesKey]]))[0]);
  await writePipelineAccess(statsId, "sam@example.com", {}, store);
  is("(with access that can be read, Sam could add it)", (await crm("sam@example.com", { action: "pipeline", pipeline: { id: "seen01", name: "Seen", stages: freshStages("s") }, moves: {} })).status, 200);
  await redisPipeline([["SET", pipesKey, pipesBefore], ["HSET", `nl:crm:pacc:${statsId}`, "sam@example.com", "{not json"]]);
  const addedBlind = await crm("sam@example.com", { action: "pipeline", pipeline: { id: "blind1", name: "Blind", stages: freshStages("b") }, moves: {} });
  is("refused as access, and nothing added", [addedBlind.status, addedBlind.body.error, String((await redisPipeline([["GET", pipesKey]]))[0]) === pipesBefore], [403, "pipeline_access", true]);
  await writePipelineAccess(statsId, "sam@example.com", {}, store);
  await redisPipeline([["SET", pipesKey, JSON.stringify(lineUp)]]);

  part("Round 8: a session let in without its second step takes nothing away here");
  const lockedSession = await openSession(owner);
  const lockedHash = createHash("sha256").update(`nimbus-2fa-locked:${lockedSession}`).digest("hex").slice(0, 40);
  await redisPipeline([["SET", `nl:2fa:locked:${lockedHash}`, String(Date.now() + 86_400_000)]]);
  const asLocked = async (body: Record<string, unknown>) => {
    const response = await CRM(new NextRequest("https://marktmorgen.com/api/store/crm", { method: "POST", headers: { "content-type": "application/json", cookie: `${SESSION_COOKIE}=${lockedSession}` }, body: JSON.stringify(body) }));
    return { status: response.status, body: (await response.json()) as Reply };
  };
  const keptDeal = (await crm(owner, { action: "deal", deal: { title: "Kept", email: "", cents: 1, stage: checked.stages[0].id, note: "" } })).body.deal!.id;
  const keptPipes = String((await redisPipeline([["GET", pipesKey]]))[0]);
  // A field kept with every person's answers: the locked session's save below would take it away (C2-76's rule, lib/two-step.ts).
  is("(a field saved)", (await crm(owner, { action: "fields", fields: [{ id: "lkfld1", name: "Company", type: "text", options: [] }] })).status, 200);
  const keptFields = (await redisPipeline([["GET", `nl:crm:fields:${statsId}`]]))[0];
  const tried = [await asLocked({ action: "fields", fields: [] }), await asLocked({ action: "unpipeline", id: other.id, moveTo: checked.stages[0].id }), await asLocked({ action: "undeal", id: keptDeal })];
  is("taking a field away, removing a pipeline and removing a deal are refused as locked", tried.map((t) => [t.status, t.body.error]), [[403, "locked"], [403, "locked"], [403, "locked"]]);
  is("and nothing was taken away", [(await redisPipeline([["HGET", dealsKey, keptDeal]]))[0] !== null, String((await redisPipeline([["GET", pipesKey]]))[0]) === keptPipes, (await redisPipeline([["GET", `nl:crm:fields:${statsId}`]]))[0] === keptFields], [true, true, true]);
  const stillOpen = await asLocked({ action: "deal", version: await versionOf(keptDeal), deal: { id: keptDeal, title: "Kept, renamed" } });
  is("changing a deal is not", [stillOpen.status, stillOpen.body.ok], [200, true]);
  is("the board says why, never that the change could not be confirmed", readFileSync("components/deals-board.tsx", "utf8").includes("locked: \"You got in without your second step, so removing a deal, a pipeline or a field waits until two-step login turns off. Nothing was removed."), true);
  is("a full session still removes it", [(await crm(owner, { action: "undeal", id: keptDeal })).status], [200]);

  part("Codex D (#2036): a partial access read never grants a restricted write");
  await putMember(store, "sam@example.com", "support");
  await writePipelineAccess(statsId, "sam@example.com", { wkshp1: "none" }, store);
  const dBody = { action: "deal", deal: { title: "D forbidden write", email: "", cents: 1, stage: "wnew01", note: "" } };
  const dControl = await crm("sam@example.com", dBody);
  is("D control: the real support session cannot write the hidden pipeline", [dControl.status,dControl.body.error], [403,"pipeline_access"]);
  const dBefore = await real([["HLEN",dealsKey]]);
  let dPartial = 0;
  redis.pipeline = (async (commands: (string | number)[][]) => {
    if(commands.length===1 && commands[0][0]==="HGET" && commands[0][1]===`nl:crm:pacc:${statsId}` && commands[0][2]==="sam@example.com") { dPartial++; return []; }
    return real(commands);
  }) as typeof redis.pipeline;
  const dAfterPartial = await crm("sam@example.com", dBody);
  redis.pipeline = real;
  const dCount = await real([["HLEN",dealsKey]]);
  is("(the partial read was made)", dPartial > 0, true);
  is("D partial read refuses and creates no deal", [dAfterPartial.status,dAfterPartial.body.error,dCount], [503,"unavailable",dBefore]);

  part("Codex D (#2036): a restriction is said saved only on a confirmed write");
  await writePipelineAccess(statsId,"sam@example.com",{},store);
  let dDropped=0;
  redis.pipeline = (async (commands: (string | number)[][]) => {
    if(commands.length===1 && commands[0][0]==="HSET" && commands[0][1]===`nl:crm:pacc:${statsId}` && commands[0][2]==="sam@example.com") { dDropped++; return []; }
    return real(commands);
  }) as typeof redis.pipeline;
  const dSave=await pacc({email:"sam@example.com",choices:{wkshp1:"none"},was:{}});
  redis.pipeline=real;
  const dActual=await readPipelineAccess(statsId,"sam@example.com");
  const dStillOpen=await crm("sam@example.com",dBody);
  is("(the write was dropped)", dDropped > 0, true);
  is("D unconfirmed restriction is never reported as saved: refused, saying it could not be confirmed", [dSave.status, dSave.body.error, dSave.body.ok, dSave.body.access], [503, "unavailable", false, undefined]);
  is("and what is read is what is really there: no restriction, so the board does not show one", [dActual, dStillOpen.status], [{}, 200]);

  part("Codex D (#2036): a lost answer after the access was applied is not said as nothing changed");
  await writePipelineAccess(statsId,"sam@example.com",{},store);
  let d9Applied=0;
  redis.pipeline=(async(commands:(string|number)[][])=>{
    if(commands.length===1&&commands[0][0]==="HSET"&&commands[0][1]===`nl:crm:pacc:${statsId}`&&commands[0][2]==="sam@example.com") {await real(commands);d9Applied++;return [];}
    return real(commands);
  }) as typeof redis.pipeline;
  const d9Answer=await pacc({email:"sam@example.com",choices:{wkshp1:"none"},was:{}});
  redis.pipeline=real;
  const d9Actual=await readPipelineAccess(statsId,"sam@example.com");
  is("(the write landed, its answer lost)", [d9Applied, d9Actual], [1, { wkshp1: "none" }]);
  is("D committed-but-unconfirmed restriction is never said unchanged: it says it could not be confirmed and to reload", [d9Answer.status, d9Answer.body.message?.includes("Nothing was changed"), d9Answer.body.message?.includes("Reload the page")], [503, false, true]);

  part("Codex D (#2036): a membership never moves without both access reads confirmed");
  const d9From="dsource@example.com",d9To="dtarget@example.com";
  await putMember(store,d9From,"support");
  await writePipelineAccess(statsId,d9From,{wkshp1:"none"},store);
  is("D migration control: source cannot write the hidden pipeline",(await crm(d9From,{action:"deal",deal:{title:"D blocked migration",email:"",cents:1,stage:"wnew01",note:""}})).status,403);
  let d9CopyRead=0;
  redis.pipeline=(async(commands:(string|number)[][])=>{
    // The copy reads the source's field by itself (fieldOf, main's #2989), so its partial answer is that one HGET's.
    if(commands.length===1&&commands[0][0]==="HGET"&&commands[0][1]===`nl:crm:pacc:${statsId}`&&commands[0][2]===d9From) {d9CopyRead++;return [];}
    return real(commands);
  }) as typeof redis.pipeline;
  try{await moveMemberships(d9From,d9To);}catch{/* refused: the membership stays */}
  redis.pipeline=real;
  const d9Members=(await readTeam(store.sid)).members.map(m=>m.email);
  const d9TargetWrite=await crm(d9To,{action:"deal",deal:{title:"D migration bypass",email:"",cents:1,stage:"wnew01",note:""}});
  is("(the partial read was made)", d9CopyRead > 0, true);
  is("D partial ACL source read keeps original membership and restriction",[d9Members.includes(d9From),d9Members.includes(d9To),await readPipelineAccess(statsId,d9From)],[true,false,{wkshp1:"none"}]);
  is("D target cannot write without confirmed migration of its restrictions",d9TargetWrite.status===200,false);

  part("Codex D and G2 (#2036): an extra answer to the copy's one write never confirms it");
  for (const [kind, from, to] of [["HSET", "dacksource@example.com", "dacktarget@example.com"], ["HDEL", "dackfree@example.com", "dackstale@example.com"]] as const) {
    await putMember(store, from, "support");
    // HSET: a restricted teammate's restriction is the copy. HDEL: a free teammate, and a field left on the new address that the copy clears.
    if (kind === "HSET") await writePipelineAccess(statsId, from, { wkshp1: "none" }, store);
    else await redisPipeline([["HSET", `nl:crm:pacc:${statsId}`, to, JSON.stringify({ wkshp1: "none" })]]);
    let skipped = 0;
    redis.pipeline = (async (commands: (string | number)[][]) => {
      if (commands.length === 1 && commands[0][0] === kind && commands[0][1] === `nl:crm:pacc:${statsId}` && commands[0][2] === to) { skipped++; return [1, 1]; }
      return real(commands);
    }) as typeof redis.pipeline;
    try { await moveMemberships(from, to); } catch { /* refused: the membership stays */ }
    redis.pipeline = real;
    const team = (await readTeam(store.sid)).members.map((m) => m.email);
    is(`${kind} answered [1, 1] and never applied: the membership stays on the old address`, [skipped, team.includes(from), team.includes(to)], [1, true, false]);
    if (kind === "HSET") {
      is("with its restriction", await readPipelineAccess(statsId, from), { wkshp1: "none" });
      is("and the new address cannot write", (await crm(to, { action: "deal", deal: { title: "D extra ACK bypass", email: "", cents: 1, stage: "wnew01", note: "" } })).status === 200, false);
    }
  }

  done();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
