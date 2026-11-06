/**
 * Sweep app1 proof (CX-123 rule 24), synthetic only. A teammate's sales-pipeline restrictions are read by
 * lib/pipeline-access.ts:41-42:
 *   const [raw] = await redisPipeline([["HGET", accessKey(statsId), normaliseEmail(email)]]);
 *   return mapOf(raw);
 * and mapOf (:24) reads `undefined` as "no restriction" ({}), which accessOf (lib/pipeline-access-rules.ts:38) turns
 * into "edit" on every pipeline. A pipeline reply with no slot (lost, empty array, short) therefore lets a teammate
 * the owner set to "view" or "none" change, move and delete deals and stages in that pipeline. The two routes in this
 * range that ask it: app/api/store/crm/route.ts:47 and app/api/store/form-opportunity/route.ts:44.
 * tests/pipeline-access.test.ts already holds that an unparseable record opens nothing; this is the reply that
 * never arrived, which reads as the opposite.
 */
import { NextRequest } from "next/server";
import { POST } from "@/app/api/store/crm/route";
import { SESSION_COOKIE, openSession } from "@/lib/auth";
import { DEFAULT_STAGES, FIRST_PIPELINE_ID } from "@/lib/crm-rules";
import { readPipelineAccess, writePipelineAccess } from "@/lib/pipeline-access";
import { readStages } from "@/lib/crm";
import { claimHandle, ensureStatsId, ensureStoreId, setStripeAccount, setSubscription, storeForEmail } from "@/lib/store";
import { putMember } from "@/lib/team";
import { store as redis } from "./redis-stub";
import { paidPeriod } from "./billing-period-fixture";
import { done, is, part } from "./check";

const realPipeline = redis.pipeline.bind(redis);
let lose: "none" | "empty" | "sparse" = "none";
redis.pipeline = (async (commands: (string | number)[][]) => {
  const asksAccess = commands.length === 1 && commands[0][0] === "HGET" && String(commands[0][1]).startsWith("nl:crm:pacc:");
  if (!asksAccess || lose === "none") return realPipeline(commands);
  await realPipeline(commands);
  return lose === "empty" ? [] : Array(1);
}) as typeof redis.pipeline;

async function main(): Promise<void> {
  redis.clear();
  const owner = "pacc@example.com";
  await claimHandle(owner, "paccshop", "Pacc Shop", "");
  await ensureStatsId(owner);
  await ensureStoreId(owner);
  await setStripeAccount(owner, "acct_1TestSweepPacc1", true);
  await setSubscription(owner, { customerId: "cus_SweepPacc001", subscriptionId: "sub_SweepPacc001", active: true, tier: "pro", period: paidPeriod() });
  const store = (await storeForEmail(owner))!;
  const statsId = store.statsId!;
  await putMember(store, "sam@example.com", "support");
  const sam = `${SESSION_COOKIE}=${await openSession("sam@example.com")}`;
  const post = async (body: Record<string, unknown>) => {
    const response = await POST(new NextRequest("https://marktmorgen.com/api/store/crm", { method: "POST", headers: { "content-type": "application/json", cookie: sam }, body: JSON.stringify(body) }));
    return { status: response.status, body: (await response.json()) as { ok?: boolean; error?: string } };
  };
  // The owner shuts Sam out of the first pipeline.
  await writePipelineAccess(statsId, "sam@example.com", { [FIRST_PIPELINE_ID]: "none" }, store);
  const renamed = DEFAULT_STAGES.map((stage, i) => (i === 0 ? { ...stage, name: "Taken over" } : stage));

  part("Healthy control: Sam, on 'none', is refused");
  is("the restriction reads back", await readPipelineAccess(statsId, "sam@example.com"), { [FIRST_PIPELINE_ID]: "none" });
  is("renaming the first pipeline's stages: 403 pipeline_access", [(await post({ action: "stages", stages: renamed })).status], [403]);
  is("adding a deal in it: 403", (await post({ action: "deal", deal: { title: "Mine now", email: "", cents: 1_000, stage: "lead00", note: "" } })).status, 403);
  is("the stages are unchanged", (await readStages(statsId))[0].name, DEFAULT_STAGES[0].name);

  for (const as of ["empty", "sparse"] as const) {
    part(`DEFECT: the restriction's reply has no slot (${as})`);
    lose = as;
    is(`DEFECT (${as}): the restriction reads as none at all`, await readPipelineAccess(statsId, "sam@example.com"), {});
    const deal = await post({ action: "deal", deal: { title: `Mine now ${as}`, email: "", cents: 1_000, stage: "lead00", note: "" } });
    is(`DEFECT (${as}): Sam adds a deal in the pipeline he was shut out of`, [deal.status, deal.body.ok], [200, true]);
    const stages = await post({ action: "stages", stages: renamed });
    is(`DEFECT (${as}): and rewrites its stages`, [stages.status, stages.body.ok], [200, true]);
    lose = "none";
  }
  is("the first pipeline's stage is now Sam's name for it", (await readStages(statsId))[0].name, "Taken over");
  is("while the owner's restriction is still stored", await readPipelineAccess(statsId, "sam@example.com"), { [FIRST_PIPELINE_ID]: "none" });
  done();
}
main();
