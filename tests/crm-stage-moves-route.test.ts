/**
 * The coordinator's triple audit of #5128 (option E), through the real route, session, store and team, against the
 * in-memory Redis double and synthetic stores only. Each part failed on 3fc4c94478:
 *
 *   - HIGH: a restricted teammate alone filled the aliases (saving his own pipeline again and again, every stage
 *     swapped, no deal anywhere), and then the owner could not remove even an empty pipeline ("stage_moves"). Now a
 *     change that would keep more than ALIAS_COMPACT_AT compacts them first, so the aliases never lock the store;
 *   - MEDIUM 1: with no destination sent, a pipeline that holds deals was removed and its deals sent to a stage nobody
 *     chose. Now it is refused ("moves"), as on main, and nothing is written; a stage removed from a pipeline that stays
 *     shows its deals in that pipeline's first open stage, the one the board shows (option B, 35th batch);
 *   - HIGH of the 35th batch: a deal written while an empty stage or pipeline was removed (after the deals were read,
 *     before the pipelines were saved) vanished, since the stage went with no alias. Now every removed stage keeps one;
 *   - MEDIUM 2: a restricted teammate could not remove their own empty pipeline with no other pipeline of theirs to
 *     send deals to (403). Now an empty one goes, once its deals are read (and paid for) to show there are none, and
 *     the answer never tells them how many studio requests that read took when they do not see every pipeline;
 *   - a board resending a removed stage hears "stage_gone", in a deal, a pipeline or the older stages request;
 *   - the pipeline answer says how many stages now show their deals elsewhere (`stagesMoved`), never "moved".
 */
import { NextRequest } from "next/server";
import { POST } from "@/app/api/store/crm/route";
import { SESSION_COOKIE, openSession } from "@/lib/auth";
import { readDeal, readPipelines, readStageView } from "@/lib/crm";
import { ALIAS_COMPACT_AT, MAX_STAGES, MAX_STAGE_MOVES, type Stage } from "@/lib/crm-rules";
import { crmAnswer } from "@/lib/crm-response";
import { writePipelineAccess } from "@/lib/pipeline-access";
import { redisPipeline } from "@/lib/redis";
import { claimHandle, ensureStatsId, ensureStoreId, setStripeAccount, setSubscription, storeForEmail } from "@/lib/store";
import { putMember } from "@/lib/team";
import { store as redis } from "./redis-stub";
import { paidPeriod } from "./billing-period-fixture";
import { done, is, part } from "./check";

type Reply = { ok?: boolean; error?: string; stagesMoved?: number; moved?: unknown; deal?: { id: string }; studioRequestsUsed?: number | string };

/** Eight stages with ids of round `k`: six open, a won and a lost. */
const round = (k: number): Stage[] => Array.from({ length: MAX_STAGES }, (_, j) => ({ id: `x${String(k).padStart(2, "0")}st${j}`, name: `Step ${j + 1}`, kind: j === MAX_STAGES - 2 ? "won" as const : j === MAX_STAGES - 1 ? "lost" as const : "open" as const }));

async function main(): Promise<void> {
  redis.clear();
  process.env.UPSTASH_REDIS_REST_URL ??= "http://stub";
  const owner = "moves-route@example.com";
  await claimHandle(owner, "movesroute", "Moves Route", "");
  await ensureStatsId(owner);
  await ensureStoreId(owner);
  await setStripeAccount(owner, "acct_1TestMovesRt01", true);
  await setSubscription(owner, { customerId: "cus_MovesRoute01", subscriptionId: "sub_MovesRoute01", active: true, tier: "pro", period: paidPeriod() });
  const store = (await storeForEmail(owner))!;
  const statsId = store.statsId!;
  await putMember(store, "sam@example.com", "support");
  const crm = async (who: string, body: Record<string, unknown>) => {
    const response = await POST(new NextRequest("https://marktmorgen.com/api/store/crm", { method: "POST", headers: { "content-type": "application/json", cookie: `${SESSION_COOKIE}=${await openSession(who)}` }, body: JSON.stringify(body) }));
    return { status: response.status, body: (await response.json()) as Reply };
  };
  const record = async () => (await redisPipeline([["GET", "nl:crm:pipes:" + statsId]]))[0];
  const dealsKey = "nl:crm:deals:" + statsId;
  /**
   * Runs `change` while a form makes a deal in `stage`: right after the deals' ids are read (HKEYS), or, when the change
   * reads none, just before the pipelines are saved, so it is never counted by the change.
   */
  const racing = async <T>(id: string, stage: string, change: () => Promise<T>): Promise<T> => {
    const plain = redis.pipeline;
    let written = false;
    const write = () => plain.call(redis, [["HSET", dealsKey, id, JSON.stringify({ id, title: "From a form, meanwhile", email: "", cents: 0, stage, note: "", createdAt: 1, updatedAt: 1 })]]);
    redis.pipeline = async (cmds) => {
      if (!written && cmds.some((c) => c[0] === "EVAL" && String(c[1]).includes("crm-pipelines-save"))) {
        written = true;
        await write();
      }
      const reply = await plain.call(redis, cmds);
      if (!written && cmds.some((c) => c[0] === "HKEYS")) {
        written = true;
        await write();
      }
      return reply;
    };
    try { return await change(); } finally { redis.pipeline = plain; }
  };
  const aliases = async () => Object.keys((await readPipelines(statsId))[0].moved ?? {}).length;

  const spare = { id: "spare1", name: "Spare", stages: [{ id: "spnew1", name: "New", kind: "open" }, { id: "spwon1", name: "Won", kind: "won" }, { id: "splst1", name: "Lost", kind: "lost" }] };
  is("(the owner adds an empty Spare pipeline)", (await crm(owner, { action: "pipeline", pipeline: spare, moves: {} })).status, 200);
  is("(and a deal in Sales)", (await crm(owner, { action: "deal", deal: { title: "Kept", email: "", cents: 1, stage: "lead00", note: "" } })).status, 200);
  let k = 0;
  let mine = { id: "samsp1", name: "Sam's", stages: round(k) };
  is("(Sam adds a pipeline of his own)", (await crm("sam@example.com", { action: "pipeline", pipeline: mine, moves: {} })).status, 200);
  await writePipelineAccess(statsId, "sam@example.com", { sales0: "view", spare1: "view" }, store);

  part("HIGH: a restricted teammate alone never locks the store's aliases");
  const statuses: number[] = [];
  let most = 0;
  for (let save = 0; save < 25; save += 1) {
    const before = mine.stages;
    mine = { ...mine, stages: round(++k) };
    // Every stage swapped, each one's (absent) deals sent to the new first stage: an alias for each without compaction.
    const answer = await crm("sam@example.com", { action: "pipeline", pipeline: mine, moves: Object.fromEntries(before.map((s) => [s.id, mine.stages[0].id])) });
    statuses.push(answer.status);
    most = Math.max(most, await aliases());
  }
  is("each of Sam's 25 saves is saved", statuses.every((s) => s === 200), true);
  is(`the aliases never pass ${ALIAS_COMPACT_AT} and a change's own (they are compacted first), far from ${MAX_STAGE_MOVES}`, most <= ALIAS_COMPACT_AT + MAX_STAGES, true);
  const removedSpare = await crm(owner, { action: "unpipeline", id: "spare1", moveTo: "" });
  is("the owner removes the empty Spare pipeline after it", [removedSpare.status, (await readPipelines(statsId)).map((p) => p.id)], [200, ["sales0", "samsp1"]]);

  part("MEDIUM 2: a restricted teammate removes their own empty pipeline, with nowhere of theirs to send deals");
  const hidden = { id: "hide01", name: "Hidden", stages: [{ id: "hinew1", name: "New", kind: "open" }, { id: "hiwon1", name: "Won", kind: "won" }, { id: "hilst1", name: "Lost", kind: "lost" }] };
  is("(the owner adds a pipeline Sam may not see)", (await crm(owner, { action: "pipeline", pipeline: hidden, moves: {} })).status, 200);
  await writePipelineAccess(statsId, "sam@example.com", { sales0: "view", hide01: "none" }, store);
  const removedMine = await crm("sam@example.com", { action: "unpipeline", id: "samsp1", moveTo: "" });
  is("removed, as on main: its deals were read, and there were none", [removedMine.status, removedMine.body.ok, (await readPipelines(statsId)).map((p) => p.id)], [200, true, ["sales0", "hide01"]]);
  is("he is told studio requests were used, never how many (it grows with deals he may not see)", removedMine.body.studioRequestsUsed, "some");
  const removedHidden = await crm(owner, { action: "unpipeline", id: "hide01", moveTo: "" });
  is("the owner, who sees every pipeline, is told how many", [removedHidden.status, typeof removedHidden.body.studioRequestsUsed === "number" && removedHidden.body.studioRequestsUsed >= 1], [200, true]);

  part("HIGH (35th batch): a deal written while an empty stage or pipeline is removed never vanishes");
  const salesNow = (await readPipelines(statsId))[0];
  const withoutOffer = { id: salesNow.id, name: salesNow.name, stages: salesNow.stages.filter((s) => s.id !== "offr00") };
  const offerGone = await racing("racedeal01", "offr00", () => crm(owner, { action: "pipeline", pipeline: withoutOffer, moves: {} }));
  is("a stage removed with no destination, a deal written into it meanwhile: it shows in New, the first open stage kept", [offerGone.status, (await readDeal(statsId, "racedeal01", await readStageView(statsId)))?.stage], [200, "lead00"]);
  const race = { id: "race01", name: "Race", stages: [{ id: "ranew1", name: "New", kind: "open" }, { id: "rawon1", name: "Won", kind: "won" }, { id: "ralst1", name: "Lost", kind: "lost" }] };
  is("(the owner adds an empty Race pipeline)", (await crm(owner, { action: "pipeline", pipeline: race, moves: {} })).status, 200);
  const raceGone = await racing("racedeal02", "ranew1", () => crm(owner, { action: "unpipeline", id: "race01", moveTo: "" }));
  is("an empty pipeline removed with no destination, a deal written into it meanwhile: it shows in New of Sales", [raceGone.status, (await readDeal(statsId, "racedeal02", await readStageView(statsId)))?.stage], [200, "lead00"]);

  part("MEDIUM 1: no destination sent for a pipeline that holds deals is refused; a stage's deals show in the board's default");
  const talking = await crm(owner, { action: "deal", deal: { title: "Talking now", email: "", cents: 1, stage: "talk00", note: "" } });
  const sales = (await readPipelines(statsId))[0];
  const withoutTalking = { id: sales.id, name: sales.name, stages: sales.stages.filter((s) => s.id !== "talk00") };
  const keptSales = await crm(owner, { action: "pipeline", pipeline: withoutTalking, moves: {} });
  is("a stage holding a deal, removed with no destination: its deal shows in New, the first open stage kept, as the board shows", [keptSales.status, keptSales.body.stagesMoved, (await readDeal(statsId, talking.body.deal!.id, await readStageView(statsId)))?.stage], [200, 1, "lead00"]);
  const coach = { id: "coach1", name: "Coach", stages: [{ id: "conew1", name: "New", kind: "open" }, { id: "cowon1", name: "Won", kind: "won" }, { id: "colst1", name: "Lost", kind: "lost" }] };
  is("(the owner adds Coach, with a deal)", [(await crm(owner, { action: "pipeline", pipeline: coach, moves: {} })).status, (await crm(owner, { action: "deal", deal: { title: "Coached", email: "", cents: 1, stage: "conew1", note: "" } })).status], [200, 200]);
  const keptCoach = await record();
  const noStage = await crm(owner, { action: "unpipeline", id: "coach1", moveTo: "" });
  is("a pipeline holding a deal, removed with no stage: 400 moves, nothing written", [noStage.status, noStage.body.error, (await record()) === keptCoach], [400, "moves", true]);
  const sent = await crm(owner, { action: "unpipeline", id: "coach1", moveTo: "lead00" });
  is("with a stage chosen it goes; the answer counts the stages moved (three), not deals", [sent.status, sent.body.stagesMoved, Object.hasOwn(sent.body, "moved")], [200, 3, false]);

  part("A removed stage resent hears that it was removed");
  const inGone = await crm(owner, { action: "deal", deal: { title: "Into a removed stage", email: "", cents: 0, stage: "talk00", note: "" } });
  is("a deal sent into it: 409 stage_gone, said in plain words on the board", [inGone.status, inGone.body.error, crmAnswer(false, inGone.body)], [409, "stage_gone", { ok: false, error: "stage_gone" }]);
  const readded = await crm(owner, { action: "pipeline", pipeline: { ...withoutTalking, stages: [...withoutTalking.stages, { id: "talk00", name: "Talking", kind: "open" }] }, moves: {} });
  is("the stage put back in a pipeline: 409 stage_gone", [readded.status, readded.body.error], [409, "stage_gone"]);
  const older = await crm(owner, { action: "stages", stages: [...withoutTalking.stages, { id: "talk00", name: "Talking", kind: "open" }] });
  is("or through the older stages request: 409 stage_gone", [older.status, older.body.error], [409, "stage_gone"]);
  done();
}
void main();
