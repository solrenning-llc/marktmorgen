/**
 * A stage taken away is read through an alias (coordinator's audit of #2048, option E): a pipeline or stage change
 * writes only the pipelines record, with `moved` on the first pipeline saying where each removed stage's deals are now
 * read, and never reads or rewrites a deal. Checked against the in-memory Redis double and synthetic stores only:
 *
 *   - the cost: removing a stage that holds MAX_DEALS deals stays inside the one studio request the route takes for it
 *     (on main it read every deal and wrote each one back, many times that request);
 *   - every reader shows the deal in the stage it went to: readDeals, readDeal, readDealExact, readOpportunityReview;
 *   - a chain (a stage removed into one that is removed later) is kept as one step;
 *   - a deal saved after the change carries the stage it is read in;
 *   - the aliases stop at MAX_STAGE_MOVES, refused in plain words with nothing written;
 *   - a removed stage's id is never a stage again;
 *   - the pipelines record at its largest, aliases included, still moves inside one studio request when it is read.
 */
import { NextRequest } from "next/server";
import { POST } from "@/app/api/store/crm/route";
import { SESSION_COOKIE, openSession } from "@/lib/auth";
import { readDeal, readDealExact, readDeals, readOpportunityReview, readPipelines, readStages, savePipelineChange, writeDeal } from "@/lib/crm";
import { DEFAULT_STAGES, FIRST_PIPELINE_ID, MAX_DEALS, MAX_PIPELINES, MAX_PIPELINE_NAME, MAX_STAGES, MAX_STAGE_MOVES, MAX_STAGE_NAME, type Deal, type Pipeline, nextStageMoves, parsePipelines } from "@/lib/crm-rules";
import { crmAnswer } from "@/lib/crm-response";
import { claimHandle, ensureListId, ensureStatsId, storeForEmail } from "@/lib/store";
import { UNIT_COST, request } from "./plan-cost-registry";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";
import { ROOM } from "./data-room";

const sales: Pipeline = { id: FIRST_PIPELINE_ID, name: "Sales", stages: DEFAULT_STAGES };
const coaching: Pipeline = { id: "coach0", name: "Coaching", stages: [{ id: "cnew00", name: "New", kind: "open" }, { id: "ccall0", name: "Call booked", kind: "open" }, { id: "cprop0", name: "Proposal", kind: "open" }, { id: "cwon00", name: "Won", kind: "won" }, { id: "clost0", name: "Lost", kind: "lost" }] };
const deal = (id: string, stage: string): Deal => ({ id, title: "Deal " + id + " with a longer title, as a creator writes one", email: "buyer" + id + "@example.com", cents: 125000, stage, note: "A note the creator keeps about this deal, a sentence or two long, so the record has a real size.", createdAt: 100, updatedAt: 200 });

async function main(): Promise<void> {
  redis.clear();
  process.env.UPSTASH_REDIS_REST_URL ??= "http://stub";
  const OWNER = "aliases@example.com";
  await claimHandle(OWNER, "aliases", "Aliases Studio", "");
  await ensureStatsId(OWNER);
  await ensureListId(OWNER);
  const statsId = (await storeForEmail(OWNER))!.statsId!;
  const dealsKey = "nl:crm:deals:" + statsId;
  is("(two pipelines)", (await savePipelineChange(statsId, { pipeline: coaching }, {}, 2, ROOM)).ok, true);
  const ids = Array.from({ length: MAX_DEALS }, (_, i) => "d" + String(i).padStart(9, "0"));
  await redis.pipeline(ids.map((id) => ["HSET", dealsKey, id, JSON.stringify(deal(id, "ccall0"))]));
  const before = (await redis.pipeline([["HGETALL", dealsKey]]))[0];

  part(`Removing a stage that holds ${MAX_DEALS.toLocaleString("en-US")} deals stays inside one studio request`);
  const original = redis.pipeline;
  let commands = 0, bytes = 0, dealCommands = 0;
  try {
    redis.pipeline = async (sent) => {
      const reply = await original.call(redis, sent);
      commands += sent.length;
      // What moves both ways on the wire: Upstash's REST answers in JSON, so a stored JSON value is escaped again.
      bytes += Buffer.byteLength(JSON.stringify(sent)) + Buffer.byteLength(JSON.stringify(reply));
      dealCommands += sent.filter((c) => c.some((part) => part === dealsKey)).length;
      return reply;
    };
    const withoutCall = { ...coaching, stages: coaching.stages.filter((s) => s.id !== "ccall0") };
    is("saved, its deals sent to Proposal", await savePipelineChange(statsId, { pipeline: withoutCall }, { ccall0: "cprop0" }, 2, ROOM).then((r) => r.ok && r.moves), { ccall0: "cprop0" });
  } finally { redis.pipeline = original; }
  is("no command reads or writes a deal", dealCommands, 0);
  is(`what it moves is priced inside the one studio request the route takes (${bytes.toLocaleString("en-US")} bytes, ${commands} commands)`, request("studio", commands, bytes) <= UNIT_COST.studio, true);
  is("every deal is byte for byte as it was", (await redis.pipeline([["HGETALL", dealsKey]]))[0], before);

  part("Every reader shows the deal in the stage it went to");
  const stages = await readStages(statsId);
  const all = await readDeals(statsId, stages);
  is("readDeals: all of them in Proposal", [all.length, all.every((d) => d.stage === "cprop0")], [MAX_DEALS, true]);
  is("readDeal", (await readDeal(statsId, ids[0], stages))?.stage, "cprop0");
  is("readDealExact, with the record as it is kept", await readDealExact(statsId, ids[1], stages).then((r) => [r.deal?.stage, r.raw === JSON.stringify(deal(ids[1], "ccall0"))]), ["cprop0", true]);
  const review = await readOpportunityReview(statsId);
  is("readOpportunityReview", [review.available, review.deals.filter((d) => d.stage === "cprop0").length], [true, MAX_DEALS]);

  part("A chain is kept as one step");
  const withoutProposal = { ...coaching, stages: coaching.stages.filter((s) => s.id !== "ccall0" && s.id !== "cprop0") };
  is("Proposal removed later, into New", (await savePipelineChange(statsId, { pipeline: withoutProposal }, { cprop0: "cnew00" }, 2, ROOM)).ok, true);
  is("both removed stages point straight at New", (await readPipelines(statsId))[0].moved, { ccall0: "cnew00", cprop0: "cnew00" });
  is("and the deals read there", (await readDeal(statsId, ids[2], await readStages(statsId)))?.stage, "cnew00");
  is("a stage still there keeps no alias", nextStageMoves({ a00000: "b00000" }, {}, new Set(["a00000", "b00000"])), {});

  part("A deal saved after the change carries the stage it is read in");
  const read = (await readDeal(statsId, ids[3], await readStages(statsId)))!;
  await writeDeal(statsId, { ...read, note: "Edited after the change" }, ROOM);
  is("its record now says New", JSON.parse(String((await redis.pipeline([["HGET", dealsKey, ids[3]]]))[0])).stage, "cnew00");

  part("A removed stage is read, never chosen");
  const sessionChoose = await openSession(OWNER);
  const chosen = await POST(new NextRequest("https://marktmorgen.com/api/store/crm", { method: "POST", headers: { "content-type": "application/json", cookie: SESSION_COOKIE + "=" + sessionChoose }, body: JSON.stringify({ action: "deal", deal: { title: "New one", email: "", cents: 0, stage: "ccall0", note: "" } }) }));
  is("a new deal sent into a removed stage is refused: that stage is gone", [chosen.status, (await chosen.json()).error, Number((await redis.pipeline([["HLEN", dealsKey]]))[0])], [400, "stage", MAX_DEALS]);

  part("A removed stage's id is never a stage again");
  is("refused, nothing written", [await savePipelineChange(statsId, { pipeline: { ...withoutProposal, stages: [...withoutProposal.stages, { id: "ccall0", name: "Call booked", kind: "open" }] } }, {}, 2, ROOM), (await readPipelines(statsId))[1].stages.map((s) => s.id)], [{ ok: false, error: "pipelines" }, ["cnew00", "cwon00", "clost0"]]);

  part(`The aliases stop at ${MAX_STAGE_MOVES}`);
  const full = Object.fromEntries(Array.from({ length: MAX_STAGE_MOVES }, (_, i) => ["x" + String(i).padStart(5, "0"), "cnew00"]));
  is(`${MAX_STAGE_MOVES} are kept`, Object.keys(nextStageMoves(full, {}, new Set(["cnew00"]))!).length, MAX_STAGE_MOVES);
  is("one more is refused", nextStageMoves(full, { cwon00: "cnew00" }, new Set(["cnew00"])), null);
  const pipes = JSON.parse(String((await redis.pipeline([["GET", "nl:crm:pipes:" + statsId]]))[0])) as Pipeline[];
  pipes[0] = { ...pipes[0], moved: full };
  await redis.pipeline([["SET", "nl:crm:pipes:" + statsId, JSON.stringify(pipes)]]);
  const recordBefore = (await redis.pipeline([["GET", "nl:crm:pipes:" + statsId]]))[0];
  const withoutTalking = { ...sales, stages: sales.stages.filter((s) => s.id !== "talk00") };
  is("a change past them is refused", await savePipelineChange(statsId, { pipeline: withoutTalking }, { talk00: "lead00" }, 2, ROOM), { ok: false, error: "stage_moves" });
  is("and writes nothing", (await redis.pipeline([["GET", "nl:crm:pipes:" + statsId]]))[0], recordBefore);
  const session = await openSession(OWNER);
  const response = await POST(new NextRequest("https://marktmorgen.com/api/store/crm", { method: "POST", headers: { "content-type": "application/json", cookie: SESSION_COOKIE + "=" + session }, body: JSON.stringify({ action: "pipeline", pipeline: withoutTalking, moves: { talk00: "lead00" } }) }));
  const body = await response.json();
  is("the route says so, and the board shows it in plain words", [response.status, crmAnswer(false, body)], [400, { ok: false, error: "stage_moves" }]);

  part("The pipelines record at its largest, with every alias, is read inside one studio request");
  let k = 0;
  const id = () => "s" + String(k++).padStart(5, "0");
  const widest = Array.from({ length: MAX_PIPELINES }, (_, i): Pipeline => ({ id: "p" + String(i).padStart(5, "0"), name: ("\u201c" + i).padEnd(MAX_PIPELINE_NAME, "\u201d"), stages: Array.from({ length: MAX_STAGES }, (_, j) => ({ id: id(), name: "\u201c".repeat(MAX_STAGE_NAME), kind: j === MAX_STAGES - 2 ? "won" as const : j === MAX_STAGES - 1 ? "lost" as const : "open" as const })) }));
  widest[0] = { ...widest[0], moved: Object.fromEntries(Array.from({ length: MAX_STAGE_MOVES }, (_, i) => ["z" + String(i).padStart(5, "0"), widest[0].stages[0].id])) };
  is("(it is a record the code keeps)", parsePipelines(widest, true)?.length, MAX_PIPELINES);
  // Read back as Upstash's REST answers: the stored JSON inside a JSON string, escaped again.
  const wire = Buffer.byteLength(JSON.stringify({ result: JSON.stringify(widest) }));
  is(`${wire.toLocaleString("en-US")} bytes on the wire, inside the 50,000 a studio request is priced at`, request("studio", 1, wire) <= UNIT_COST.studio && wire < 50_000, true);
  done();
}
void main();
