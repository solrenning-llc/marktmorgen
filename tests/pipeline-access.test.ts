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
import { SESSION_COOKIE, openSession } from "@/lib/auth";
import { DEFAULT_STAGES, FIRST_PIPELINE_ID, type Pipeline } from "@/lib/crm-rules";
import { PIPELINE_ACCESS_REFUSAL, accessOf, parseAccessMap, pipelineOfStage, visiblePipelines } from "@/lib/pipeline-access-rules";
import { readPipelineAccess, writePipelineAccess } from "@/lib/pipeline-access";
import { redisPipeline } from "@/lib/redis";
import { claimHandle, ensureStatsId, ensureStoreId, setStripeAccount, setSubscription, storeForEmail } from "@/lib/store";
import { putMember, removeMember } from "@/lib/team";
import { readFileSync } from "node:fs";
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
  const deal = async (who: keyof typeof cookies, stage: string, id?: string) => post(who, { action: "deal", deal: { ...(id ? { id } : {}), title: "Ten seats", email: "", cents: 50_000, stage, note: "" } });

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

  const [key] = (await redis.keys()).filter((k: string) => k.startsWith("nl:crm:pacc:"));
  await redisPipeline([["HSET", key, "sam@example.com", "{not json"]]);
  is("a record that cannot be read refuses every change", [await readPipelineAccess(statsId, "sam@example.com"), (await deal("sam", "lead00")).status], [null, 403]);

  part("Leaving the team");
  await writePipelineAccess(statsId, "sam@example.com", { wkshp1: "view" }, store);
  await removeMember(store, "sam@example.com");
  is("their restrictions go with them", await readPipelineAccess(statsId, "sam@example.com"), {});

  part("The form route too");
  const form = readFileSync("app/api/store/form-opportunity/route.ts", "utf8");
  is("a deal made from a form goes only where its maker may change", form.includes('accessOf(guarded.role, await readPipelineAccess(store.statsId, guarded.email), pipeline) !== "edit"') && form.includes('error: "pipeline_access"'), true);

  done();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
