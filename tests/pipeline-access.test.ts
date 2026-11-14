/**
 * 639 [GL7](7), unit 1: who on the team may change each sales pipeline
 * (lib/pipeline-access-rules.ts, lib/pipeline-access.ts), enforced by the
 * real deal routes (app/api/store/crm, app/api/store/form-opportunity)
 * through session and store. The owner and Admins always edit every
 * pipeline; a teammate edits all of them until restricted; "view" and
 * "none" refuse every change, moving a deal in or out included; a record
 * that cannot be read opens nothing; leaving the team takes it away.
 */
import { NextRequest } from "next/server";
import { POST } from "@/app/api/store/crm/route";
import { dealVersion } from "@/lib/crm";
import { SESSION_COOKIE, openSession } from "@/lib/auth";
import { DEFAULT_STAGES, FIRST_PIPELINE_ID, type Pipeline } from "@/lib/crm-rules";
import { PIPELINE_ACCESS_REFUSAL, accessOf, parseAccessMap, pipelineOfStage, visiblePipelines } from "@/lib/pipeline-access-rules";
import { readPipelineAccess, writePipelineAccess } from "@/lib/pipeline-access";
import { redisPipeline } from "@/lib/redis";
import { dataKey } from "@/lib/store-data";
import { dataBytes } from "@/lib/store-data-rules";
import { crmAnswer } from "@/lib/crm-response";
import { POST as FORM } from "@/app/api/store/form-opportunity/route";
import { claimHandle, ensureStatsId, ensureStoreId, setStripeAccount, setSubscription, storeForEmail } from "@/lib/store";
import { moveMemberships, putMember, removeMember } from "@/lib/team";
import { TEAM_ROLES, can } from "@/lib/team-roles";
import { store as redis } from "./redis-stub";
import { paidPeriod } from "./billing-period-fixture";
import { done, is, part } from "./check";

type Reply = { ok?: boolean; error?: string; message?: string; deal?: { id: string } };

async function main(): Promise<void> {
  const workshops: Pipeline = { id: "wkshp1", name: "Workshops", stages: [{ id: "wnew01", name: "New", kind: "open" }, { id: "wwon01", name: "Won", kind: "won" }, { id: "wlost1", name: "Lost", kind: "lost" }] };
  const pipelines: Pipeline[] = [{ id: FIRST_PIPELINE_ID, name: "Sales", stages: DEFAULT_STAGES }, workshops];

  part("The rules");
  is("the owner and Admins edit every pipeline, whatever is set", [accessOf("owner", { wkshp1: "none" }, "wkshp1"), accessOf("admin", null, "wkshp1")], ["edit", "edit"]);
  is("a teammate edits until restricted", [accessOf("support", {}, "wkshp1"), accessOf("editor", { wkshp1: "view" }, "wkshp1"), accessOf("support", { wkshp1: "none" }, "wkshp1")], ["edit", "view", "none"]);
  is("a record that cannot be read opens nothing", accessOf("support", null, FIRST_PIPELINE_ID), "none");
  is("only real pipelines, only view or none, are kept", parseAccessMap({ wkshp1: "view", sales0: "none", "../x": "view", abcdef: "edit", other: "none" }), { wkshp1: "view", sales0: "none" });
  is("a stage's pipeline", [pipelineOfStage(pipelines, "wnew01"), pipelineOfStage(pipelines, "lead00"), pipelineOfStage(pipelines, "nope00")], ["wkshp1", FIRST_PIPELINE_ID, null]);
  is("what a teammate sees, and how", visiblePipelines(pipelines, "support", { wkshp1: "none", sales0: "view" }).map((p) => [p.id, p.access]), [[FIRST_PIPELINE_ID, "view"]]);

  part("Through the deal routes");
  redis.clear();
  const owner = "pipes@example.com";
  await claimHandle(owner, "pipeshop", "Pipe Shop", "");
  await ensureStatsId(owner);
  await ensureStoreId(owner);
  await setStripeAccount(owner, "acct_1TestPipes0002", true);
  await setSubscription(owner, { customerId: "cus_PipeAccess01", subscriptionId: "sub_PipeAccess01", active: true, tier: "pro", period: paidPeriod() });
  const store = (await storeForEmail(owner))!;
  const statsId = store.statsId!;
  await putMember(store, "sam@example.com", "support");
  await putMember(store, "ada@example.com", "admin");
  const cookies = { owner: `${SESSION_COOKIE}=${await openSession(owner)}`, sam: `${SESSION_COOKIE}=${await openSession("sam@example.com")}`, ada: `${SESSION_COOKIE}=${await openSession("ada@example.com")}` };
  const post = async (who: keyof typeof cookies, body: Record<string, unknown>) => {
    const response = await POST(new NextRequest("https://marktmorgen.com/api/store/crm", { method: "POST", headers: { "content-type": "application/json", cookie: cookies[who] }, body: JSON.stringify(body) }));
    return { status: response.status, body: (await response.json()) as Reply };
  };
  const addedPipeline = await post("owner", { action: "pipeline", pipeline: workshops, moves: {} });
  is("the owner adds a second pipeline", [addedPipeline.status, addedPipeline.body.error], [200, undefined]);
  // A change to a deal sends the version of its record as stored now (635 [GL3]).
  const versionOf = async (id: string) => dealVersion(String((await redisPipeline([["HGET", "nl:crm:deals:" + statsId, id]]))[0]));
  const deal = async (who: keyof typeof cookies, stage: string, id?: string) => post(who, { action: "deal", ...(id ? { version: await versionOf(id) } : {}), deal: { ...(id ? { id } : {}), title: "Ten seats", email: "", cents: 50_000, stage, note: "" } });

  const free = await deal("sam", "wnew01");
  is("unrestricted, a teammate adds a deal anywhere, as before", free.status, 200);
  const workshopDeal = free.body.deal!.id;

  await writePipelineAccess(statsId, "sam@example.com", { wkshp1: "view" }, store);
  const refused = await deal("sam", "wwon01", workshopDeal);
  is("on view, a change is refused, saying why", [refused.status, refused.body.error, refused.body.message], [403, "pipeline_access", PIPELINE_ACCESS_REFUSAL]);
  is("a deal is not moved out of it either", (await deal("sam", "lead00", workshopDeal)).status, 403);
  is("nor a new one put into it", (await deal("sam", "wnew01")).status, 403);
  is("nor removed from it", (await post("sam", { action: "undeal", id: workshopDeal })).status, 403);
  is("nor its stages changed, nor the pipeline removed", [(await post("sam", { action: "pipeline", pipeline: { ...workshops, name: "Mine" }, moves: {} })).status, (await post("sam", { action: "unpipeline", id: "wkshp1", moveTo: "lead00" })).status], [403, 403]);
  is("the other pipeline is still theirs", (await deal("sam", "lead00")).status, 200);
  is("an Admin is never restricted", (await deal("ada", "wwon01", workshopDeal)).status, 200);
  is("nor the owner", (await deal("owner", "wnew01", workshopDeal)).status, 200);

  await writePipelineAccess(statsId, "sam@example.com", { sales0: "none" }, store);
  is("on none, the first pipeline's old stage route is refused too", (await post("sam", { action: "stages", stages: DEFAULT_STAGES })).status, 403);
  is("while the pipeline they may still change stays theirs", (await deal("sam", "wnew01", workshopDeal)).status, 200);
  is("removing a pipeline into one they cannot change is refused", (await post("sam", { action: "unpipeline", id: "wkshp1", moveTo: "lead00" })).status, 403);
  is("nor are a removed stage's deals sent into one they cannot change", (await post("sam", { action: "pipeline", pipeline: { ...workshops, stages: workshops.stages.filter((st) => st.id !== "wnew01") }, moves: { wnew01: "lead00" } })).status, 403);

  const [key] = (await redis.keys()).filter((k: string) => k.startsWith("nl:crm:pacc:"));
  await redisPipeline([["HSET", key, "sam@example.com", "{not json"]]);
  is("a record that cannot be read refuses every change", [await readPipelineAccess(statsId, "sam@example.com"), (await deal("sam", "lead00")).status], [null, 403]);

  part("Found in review: every other way in");
  await writePipelineAccess(statsId, "sam@example.com", { sales0: "none" }, store);
  const ownerDeal = (await deal("owner", "wnew01")).body.deal!.id;
  const stringMoves = await post("sam", { action: "pipeline", pipeline: { ...workshops, stages: workshops.stages.filter((st) => st.id !== "wnew01") }, moves: "lead00" });
  is("a removed stage's deals sent by one stage for all (a string) into a pipeline they cannot change: refused", stringMoves.status, 403);
  is("and the deal did not move", (await post("owner", { action: "deal", version: await versionOf(ownerDeal), deal: { id: ownerDeal, title: "Ten seats", email: "", cents: 50_000, stage: "wnew01", note: "" } })).status, 200);
  const dealsKeyOf = `nl:crm:deals:${statsId}`;
  await redisPipeline([["HSET", dealsKeyOf, "unread0001", "{not json"]]);
  const unreadRemoval = await post("sam", { action: "undeal", id: "unread0001" });
  is("a deal that is not there, or cannot be read, is never removed by someone limited", [(await post("sam", { action: "undeal", id: "zzzzzzzzzz" })).status, unreadRemoval.status, (await redisPipeline([["HGET", dealsKeyOf, "unread0001"]]))[0]], [403, 403, "{not json"]);
  await redisPipeline([["HDEL", dealsKeyOf, "unread0001"]]);
  const roomOf = async () => Number((await redisPipeline([["HGET", dataKey(store)!, "crm:pacc"]]))[0] ?? 0);
  const roomBefore = await roomOf();
  await moveMemberships("sam@example.com", "sam2@example.com");
  cookies.sam = `${SESSION_COOKIE}=${await openSession("sam2@example.com")}`;
  is("the room the restrictions take moves with them: the old address gives its own back, the new one takes its own", [roomBefore > 0, (await roomOf()) - roomBefore], [true, dataBytes(["sam2@example.com", JSON.stringify({ sales0: "none" })], 1) - dataBytes(["sam@example.com", JSON.stringify({ sales0: "none" })], 1)]);
  is("moving their sign-in to another address keeps exactly their restrictions", [await readPipelineAccess(statsId, "sam@example.com"), await readPipelineAccess(statsId, "sam2@example.com")], [{}, { sales0: "none" }]);
  is("and the new address is refused where the old one was", (await deal("sam", "lead00")).status, 403);
  await moveMemberships("sam2@example.com", "sam@example.com");
  cookies.sam = `${SESSION_COOKIE}=${await openSession("sam@example.com")}`;
  // A store whose data room is full: changing one's sign-in moves a record, it never refuses.
  const [usedBefore] = await redisPipeline([["HGET", dataKey(store)!, "#"]]);
  await redisPipeline([["HSET", dataKey(store)!, "#", 10 ** 12]]);
  await moveMemberships("sam@example.com", "sam4@example.com");
  cookies.sam = `${SESSION_COOKIE}=${await openSession("sam4@example.com")}`;
  is("with the store's data room full, the new address still gets the store and exactly its restrictions", [await readPipelineAccess(statsId, "sam4@example.com"), await readPipelineAccess(statsId, "sam@example.com"), (await deal("sam", "wnew01")).status !== 403, (await deal("sam", "lead00")).status], [{ sales0: "none" }, {}, true, 403]);
  await moveMemberships("sam4@example.com", "sam@example.com");
  cookies.sam = `${SESSION_COOKIE}=${await openSession("sam@example.com")}`;
  await redisPipeline([["HSET", dataKey(store)!, "#", Number(usedBefore ?? 0)]]);

  part("Moving one's sign-in when the database fails");
  await writePipelineAccess(statsId, "sam@example.com", { sales0: "none" }, store);
  const realPipeline = redis.pipeline.bind(redis);
  // Both the read of the restrictions and any write of them fail while the sign-in moves.
  redis.pipeline = (async (commands: (string | number)[][]) => {
    if (commands.some((c) => (c[0] === "HGET" || c[0] === "HSET") && String(c[1]).startsWith("nl:crm:pacc:"))) throw new Error("stand-in failure");
    // As the real Redis does: SREM with a key and no member is an error.
    if (commands.some((c) => c[0] === "SREM" && c.length < 3)) throw new Error("ERR wrong number of arguments for 'srem' command");
    return realPipeline(commands);
  }) as typeof redis.pipeline;
  let threw = false;
  await moveMemberships("sam@example.com", "sam3@example.com").catch(() => { threw = true; });
  is("when every store stays on the old address, nothing is sent that the real database refuses: the move finishes", threw, false);
  redis.pipeline = realPipeline;
  cookies.sam = `${SESSION_COOKIE}=${await openSession("sam3@example.com")}`;
  is("the new address never gets the store without its restrictions: it is not on the team at all", (await deal("sam", "wnew01")).status >= 400, true);
  is("and the old address keeps its membership and its restrictions", [await readPipelineAccess(statsId, "sam@example.com"), (await readPipelineAccess(statsId, "sam3@example.com"))], [{ sales0: "none" }, {}]);
  cookies.sam = `${SESSION_COOKIE}=${await openSession("sam@example.com")}`;
  is("the old address still works, still restricted", [(await deal("sam", "wnew01")).status, (await deal("sam", "lead00")).status], [200, 403]);

  part("Leaving the team");
  await writePipelineAccess(statsId, "sam@example.com", { wkshp1: "view" }, store);
  is("(their restrictions take room)", (await roomOf()) > 0, true);
  await removeMember(store, "sam@example.com");
  is("their restrictions go with them", await readPipelineAccess(statsId, "sam@example.com"), {});
  is("and so does the room they took: none is left held", await roomOf(), 0);

  part("The form route too");
  await putMember(store, "sam@example.com", "support");
  await writePipelineAccess(statsId, "sam@example.com", { sales0: "none" }, store);
  const fromForm = await FORM(new NextRequest("https://marktmorgen.com/api/store/form-opportunity", { method: "POST", headers: { "content-type": "application/json", cookie: cookies.sam }, body: JSON.stringify({ form: "f000000001", responseRef: "a".repeat(64), deal: { title: "From a form", note: "", email: "", cents: 0, stage: "lead00" } }) }));
  is("a deal made from a form: someone who can be restricted cannot make one at all (export is the owner's and Admins'), so a pipeline they may not change is never reached", [fromForm.status, ((await fromForm.json()) as { error?: string }).error], [403, "role"]);
  // The form route has no pipeline check because of this: should a role that can be restricted ever
  // be given "export", this fails, and the route must then check the pipeline before it answers.
  const restrictable = (["owner", ...TEAM_ROLES] as const).filter((role) => accessOf(role, { sales0: "none" }, "sales0") !== "edit");
  is("every role pipeline access can restrict is one that cannot make a deal from a form", [restrictable.length > 0, restrictable.filter((role) => can(role, "export"))], [true, []]);

  part("Found in review of units 2 and 3");
  // sam is a Support teammate again, with no access to Sales.
  const madeByThem = await post("sam", { action: "pipeline", pipeline: { id: "mine01", name: "Mine", stages: [{ id: "mnew01", name: "New", kind: "open" }, { id: "mwon01", name: "Won", kind: "won" }, { id: "mlst01", name: "Lost", kind: "lost" }] }, moves: {} });
  const back = (madeByThem.body as { pipelines?: { id: string }[] }).pipelines?.map((p) => p.id) ?? [];
  is("a pipeline they add comes back without the names and stages of the ones they may not see", [madeByThem.status, back.includes("mine01"), back.includes(FIRST_PIPELINE_ID)], [200, true, false]);
  const emptied = await post("sam", { action: "unpipeline", id: "mine01", moveTo: "" });
  is("an empty pipeline they may change can be removed, with no destination to check", emptied.status, 200);
  const refusedNow = await deal("sam", "lead00");
  is("a change refused by access is a refusal the board shows as such, never an unconfirmed write", [refusedNow.status, crmAnswer(false, refusedNow.body)], [403, { ok: false, error: "pipeline_access" }]);

  done();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
