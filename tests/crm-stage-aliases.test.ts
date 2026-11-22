/**
 * A stage taken away is read through an alias (coordinator's audit of #2048, option E): a pipeline or stage change
 * writes the pipelines record, with `moved` on the first pipeline saying where each removed stage's deals are now
 * read. Checked against the in-memory Redis double and synthetic stores only:
 *
 *   - the cost: removing a stage that holds MAX_DEALS deals, with a destination, reads or writes no deal;
 *   - every reader shows the deal in the stage it went to, through the view it is given (parseDeal's `moved`);
 *   - a chain (a stage removed into one that is removed later) is kept as one step;
 *   - a deal saved after the change carries the stage it is read in;
 *   - a stage removed with no destination goes only once the deals, read and paid for, show it holds none, and then
 *     spends no alias;
 *   - past ALIAS_COMPACT_AT the aliases are compacted: every deal kept in an older one is written where it shows, its
 *     updatedAt and every other field as they were, and those aliases go; an allowance spent part way leaves what was
 *     written right and every alias still read; one that cannot be freed is "stage_moves", 409 from both paths;
 *   - the whole request, every command and byte both ways and its trips, in its worst cases, under the studio requests
 *     it took (tests/plan-cost-registry.ts, crmDealScanCost).
 */
import { readFileSync } from "node:fs";
import { NextRequest } from "next/server";
import { POST } from "@/app/api/store/crm/route";
import { SESSION_COOKIE, openSession } from "@/lib/auth";
import { DEAL_WIRE_BYTES, type StudioPayer, readDeal, readDealExact, readDeals, readOpportunityReview, readPipelines, readStageView, savePipelineChange, writeDeal } from "@/lib/crm";
import { ALIAS_COMPACT_AT, DEFAULT_STAGES, FIRST_PIPELINE_ID, MAX_DEALS, MAX_DEAL_NOTE, MAX_DEAL_TITLE, MAX_PIPELINES, MAX_PIPELINE_NAME, MAX_STAGES, MAX_STAGE_MOVES, MAX_STAGE_NAME, type Deal, type Pipeline, copyPipeline, nextStageMoves, parseDeal, parsePipelines } from "@/lib/crm-rules";
import { crmAnswer } from "@/lib/crm-response";
import { writePipelineAccess } from "@/lib/pipeline-access";
import { claimHandle, ensureListId, ensureStatsId, ensureStoreId, setStripeAccount, setSubscription, storeForEmail } from "@/lib/store";
import { allowanceUsed } from "@/lib/store-allowance";
import { putMember } from "@/lib/team";
import { UNIT_COST, crmDealScanCost, request } from "./plan-cost-registry";
import { store as redis } from "./redis-stub";
import { paidPeriod } from "./billing-period-fixture";
import { done, is, part } from "./check";
import { ROOM } from "./data-room";

const sales: Pipeline = { id: FIRST_PIPELINE_ID, name: "Sales", stages: DEFAULT_STAGES };
const coaching: Pipeline = { id: "coach0", name: "Coaching", stages: [{ id: "cnew00", name: "New", kind: "open" }, { id: "ccall0", name: "Call booked", kind: "open" }, { id: "cprop0", name: "Proposal", kind: "open" }, { id: "cwon00", name: "Won", kind: "won" }, { id: "clost0", name: "Lost", kind: "lost" }] };
const deal = (id: string, stage: string): Deal => ({ id, title: "Deal " + id + " with a longer title, as a creator writes one", email: "buyer" + id + "@example.com", cents: 125000, stage, note: "A note the creator keeps about this deal, a sentence or two long, so the record has a real size.", createdAt: 100, updatedAt: 200 });
/** A deal at its widest as kept: every text field at its cap, each unit a lone half of a pair (six bytes escaped). */
const half = (n: number) => "\ud800".repeat(n);
const widest = (id: string, stage: string) => ({ formResponseRef: "f".repeat(64), id, title: half(MAX_DEAL_TITLE), email: half(254), cents: 10_000_000_000, stage, note: half(MAX_DEAL_NOTE), nextAction: half(200), dueDate: "2026-12-31", assignee: half(254), createdAt: 9_007_199_254_740_991, updatedAt: 9_007_199_254_740_991 });
const ids = Array.from({ length: MAX_DEALS }, (_, i) => "d" + String(i).padStart(9, "0"));
/** A payer for the library's own calls: counts what it is asked for, and stops paying after `takes` takes. */
const paying = (takes = Number.POSITIVE_INFINITY) => {
  const book = { taken: 0, forced: 0, takes: 0 };
  const payer: StudioPayer = {
    take: async (units) => {
      if (book.takes >= takes) return { ok: false, reason: "used" };
      book.takes += 1;
      book.taken += units;
      return { ok: true };
    },
    force: async (units) => { book.forced += units; },
  };
  return { payer, book };
};
/** A store on Studio, with its own statsId, for one case. */
async function studioStore(handle: string) {
  const owner = handle + "@example.com";
  await claimHandle(owner, handle, handle, "");
  await ensureStatsId(owner);
  await ensureStoreId(owner);
  await ensureListId(owner);
  await setStripeAccount(owner, "acct_1Test" + handle.slice(0, 10).padEnd(10, "0"), true);
  await setSubscription(owner, { customerId: "cus_" + handle, subscriptionId: "sub_" + handle, active: true, tier: "pro", period: paidPeriod() });
  return { owner, store: (await storeForEmail(owner))! };
}

async function main(): Promise<void> {
  redis.clear();
  process.env.UPSTASH_REDIS_REST_URL ??= "http://stub";
  const OWNER = "aliases@example.com";
  await claimHandle(OWNER, "aliases", "Aliases Studio", "");
  await ensureStatsId(OWNER);
  await ensureListId(OWNER);
  const statsId = (await storeForEmail(OWNER))!.statsId!;
  const dealsKey = "nl:crm:deals:" + statsId;
  const pipesKey = "nl:crm:pipes:" + statsId;
  is("(two pipelines)", (await savePipelineChange(statsId, { pipeline: coaching }, {}, 2, ROOM)).ok, true);
  await redis.pipeline(ids.map((id) => ["HSET", dealsKey, id, JSON.stringify(deal(id, "ccall0"))]));
  const before = (await redis.pipeline([["HGETALL", dealsKey]]))[0];

  part(`Removing a stage that holds ${MAX_DEALS.toLocaleString("en-US")} deals, with a destination, reads no deal`);
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
  const view = await readStageView(statsId);
  is("the view names the alias, as a field of its own", view.moved, { ccall0: "cprop0" });
  const all = await readDeals(statsId, view);
  is("readDeals: all of them in Proposal", [all.length, all.every((d) => d.stage === "cprop0")], [MAX_DEALS, true]);
  is("readDeal", (await readDeal(statsId, ids[0], view))?.stage, "cprop0");
  is("readDealExact, with the record as it is kept", await readDealExact(statsId, ids[1], view).then((r) => [r.deal?.stage, r.raw === JSON.stringify(deal(ids[1], "ccall0"))]), ["cprop0", true]);
  const review = await readOpportunityReview(statsId);
  is("readOpportunityReview", [review.available, review.deals.filter((d) => d.stage === "cprop0").length], [true, MAX_DEALS]);
  is("parseDeal reads through the aliases it is given, and only those", [parseDeal(deal(ids[0], "ccall0"), view.stages, view.moved)?.stage, parseDeal(deal(ids[0], "ccall0"), view.stages, {})], ["cprop0", null]);
  is("a copied pipeline never takes a removed stage's id", copyPipeline(coaching, await readPipelines(statsId), (() => { const next = ["pipe01", "ccall0", "fresh1", "fresh2", "fresh3", "fresh4", "fresh5", "fresh6"]; return () => next.shift() ?? "zzzzzz"; })()).stages.some((s) => s.id === "ccall0"), false);

  part("A chain is kept as one step");
  const withoutProposal = { ...coaching, stages: coaching.stages.filter((s) => s.id !== "ccall0" && s.id !== "cprop0") };
  is("Proposal removed later, into New", (await savePipelineChange(statsId, { pipeline: withoutProposal }, { cprop0: "cnew00" }, 2, ROOM)).ok, true);
  is("both removed stages point straight at New", (await readPipelines(statsId))[0].moved, { ccall0: "cnew00", cprop0: "cnew00" });
  is("and the deals read there", (await readDeal(statsId, ids[2], await readStageView(statsId)))?.stage, "cnew00");
  is("a stage still there keeps no alias", nextStageMoves({ a00000: "b00000" }, {}, new Set(["a00000", "b00000"])), {});

  part("A deal saved after the change carries the stage it is read in");
  const read = (await readDeal(statsId, ids[3], await readStageView(statsId)))!;
  await writeDeal(statsId, { ...read, note: "Edited after the change" }, ROOM);
  is("its record now says New", JSON.parse(String((await redis.pipeline([["HGET", dealsKey, ids[3]]]))[0])).stage, "cnew00");

  part("A removed stage's id is never a stage again");
  is("refused as a stage removed, nothing written", [await savePipelineChange(statsId, { pipeline: { ...withoutProposal, stages: [...withoutProposal.stages, { id: "ccall0", name: "Call booked", kind: "open" }] } }, {}, 2, ROOM), (await readPipelines(statsId))[1].stages.map((s) => s.id)], [{ ok: false, error: "stage_gone" }, ["cnew00", "cwon00", "clost0"]]);

  part("A stage removed with no destination goes only once the deals show it holds none, and spends no alias");
  const recordNow = (await redis.pipeline([["GET", pipesKey]]))[0];
  const withoutOffer = { ...sales, stages: sales.stages.filter((s) => s.id !== "offr00") };
  is("not paid for: refused, nothing written (the deals are never read for free)", [await savePipelineChange(statsId, { pipeline: withoutOffer }, {}, 2, ROOM), (await redis.pipeline([["GET", pipesKey]]))[0] === recordNow], [{ ok: false, error: "unavailable" }, true]);
  const empty = paying();
  const goneEmpty = await savePipelineChange(statsId, { pipeline: withoutOffer }, {}, 2, ROOM, empty.payer);
  is("paid: Offer sent holds no deal, so it goes with no alias", [goneEmpty.ok && goneEmpty.moves, (await readPipelines(statsId))[0].moved], [{}, { ccall0: "cnew00", cprop0: "cnew00" }]);
  is(`the read took its studio requests first (${empty.book.taken} for ${MAX_DEALS.toLocaleString("en-US")} deals), and nothing past them`, [empty.book.taken > 0, empty.book.forced], [true, 0]);
  const withoutNew = { ...withoutProposal, stages: withoutProposal.stages.filter((s) => s.id !== "cnew00").concat([{ id: "cnext0", name: "Next", kind: "open" }]) };
  const keptNow = (await redis.pipeline([["GET", pipesKey]]))[0];
  is("New, where every deal shows, with no destination: refused, nothing written", [await savePipelineChange(statsId, { pipeline: withoutNew }, {}, 2, ROOM, paying().payer), (await redis.pipeline([["GET", pipesKey]]))[0] === keptNow], [{ ok: false, error: "moves" }, true]);

  part(`Past ${ALIAS_COMPACT_AT} aliases, the deals kept in older ones are written where they show and those aliases go`);
  // The record with every alias it may keep: the deals in ccall0 and cprop0, and 198 more stages taken away long ago.
  const older = Object.fromEntries(Array.from({ length: MAX_STAGE_MOVES - 2 }, (_, i) => ["z" + String(i).padStart(5, "0"), "cnew00"]));
  const pipes = JSON.parse(String((await redis.pipeline([["GET", pipesKey]]))[0])) as Pipeline[];
  pipes[0] = { ...pipes[0], moved: { ...pipes[0].moved, ...older } };
  await redis.pipeline([["SET", pipesKey, JSON.stringify(pipes)]]);
  // A hundred deals kept in the older aliases too, one in each of the first hundred.
  await redis.pipeline(ids.slice(0, 100).map((id, i) => ["HSET", dealsKey, id, JSON.stringify({ ...deal(id, "z" + String(i).padStart(5, "0")), futureMetadata: { kept: i } })]));
  const shownBefore = (await readDeals(statsId, await readStageView(statsId))).map((d) => [d.id, d.stage]).sort();
  const recordBefore = (await redis.pipeline([["GET", pipesKey]]))[0];
  const withoutTalking = { ...sales, stages: withoutOffer.stages.filter((s) => s.id !== "talk00") };
  const short = paying(1 + Math.ceil(MAX_DEALS / 100) + 3);
  const spent = await savePipelineChange(statsId, { pipeline: withoutTalking }, { talk00: "lead00" }, 2, ROOM, short.payer);
  const written = (await redis.pipeline([["HVALS", dealsKey]]))[0] as string[];
  const rewritten = written.filter((raw) => ["cnew00"].includes(JSON.parse(raw).stage)).length;
  is("the allowance spent part way: refused in plain words, the pipelines as they were", [spent, crmAnswer(false, { ok: false, error: "studio_used" }), (await redis.pipeline([["GET", pipesKey]]))[0] === recordBefore], [{ ok: false, error: "studio_used" }, { ok: false, error: "studio_used" }, true]);
  is("the batches paid for were written (three of ten), the rest left in their aliases", [rewritten, written.length], [300, MAX_DEALS]);
  is("and every deal still shows where it did", (await readDeals(statsId, await readStageView(statsId))).map((d) => [d.id, d.stage]).sort(), shownBefore);
  const full = paying();
  const compacted = await savePipelineChange(statsId, { pipeline: withoutTalking }, { talk00: "lead00" }, 2, ROOM, full.payer);
  is("paid in full: saved, with only the alias of the stage removed now", [compacted.ok, (await readPipelines(statsId))[0].moved], [true, { talk00: "lead00" }]);
  is("every deal is written in the stage it showed in", (await readDeals(statsId, await readStageView(statsId))).map((d) => [d.id, d.stage]).sort(), shownBefore);
  const sample = JSON.parse(String((await redis.pipeline([["HGET", dealsKey, ids[7]]]))[0]));
  is("with its updatedAt and every other field, unknown ones too, as they were", sample, { ...deal(ids[7], "cnew00"), futureMetadata: { kept: 7 } });
  is("and no workflow, reminder or webhook started: the compaction never reaches lib/deal-stage-trigger.ts", /from "@\/lib\/deal-stage-trigger"|dealEnteredStage\(/.test(readFileSync("lib/crm.ts", "utf8")), false);

  part("Aliases that cannot be freed are \"stage_moves\", 409 from both paths");
  // Every alias kept, each held by a deal that changes while it is being written (so none can go): reached only then.
  const st = await studioStore("aliasstuck");
  const stStats = st.store.statsId!;
  const kept200 = Object.fromEntries(Array.from({ length: MAX_STAGE_MOVES }, (_, i) => ["y" + String(i).padStart(5, "0"), "lead00"]));
  await redis.pipeline([["SET", "nl:crm:pipes:" + stStats, JSON.stringify([{ ...sales, moved: kept200 }])], ...ids.slice(0, MAX_STAGE_MOVES).map((id, i) => ["HSET", "nl:crm:deals:" + stStats, id, JSON.stringify(deal(id, "y" + String(i).padStart(5, "0")))])]);
  const sessionStuck = await openSession(st.owner);
  const post = async (body: Record<string, unknown>) => {
    const plain = redis.pipeline;
    try {
      // Each deal changed meanwhile: MOVE_CRM_DEAL answers that the record is not the one read.
      redis.pipeline = async (cmds) => cmds.some((c) => c[0] === "EVAL" && String(c[1]).includes("crm-deal-move")) ? cmds.map(() => [-1, 10]) : plain.call(redis, cmds);
      const r = await POST(new NextRequest("https://marktmorgen.com/api/store/crm", { method: "POST", headers: { "content-type": "application/json", cookie: SESSION_COOKIE + "=" + sessionStuck }, body: JSON.stringify(body) }));
      return { status: r.status, body: await r.json() };
    } finally { redis.pipeline = plain; }
  };
  const stuckBefore = (await redis.pipeline([["GET", "nl:crm:pipes:" + stStats]]))[0];
  const newWon = sales.stages.filter((s) => s.id !== "won000").concat([{ id: "won001", name: "Won", kind: "won" }]);
  const viaPipeline = await post({ action: "pipeline", pipeline: { ...sales, stages: newWon }, moves: { won000: "won001" } });
  const viaStages = await post({ action: "stages", stages: newWon });
  is("the same status and words from a pipeline and from the older stages request", [viaPipeline.status, viaPipeline.body.error, viaStages.status, viaStages.body.error, crmAnswer(false, viaPipeline.body)], [409, "stage_moves", 409, "stage_moves", { ok: false, error: "stage_moves" }]);
  is("nothing written", (await redis.pipeline([["GET", "nl:crm:pipes:" + stStats]]))[0], stuckBefore);
  const board = readFileSync("components/deals-board.tsx", "utf8").split("\n").filter((line) => /^\s*(stage_moves|stage_gone|studio_used|unavailable|moves):/.test(line));
  is("no words the creator reads about it say a number", [board.length, board.some((line) => /\d/.test(line))], [5, false]);

  part("The pipelines record at its largest, with every alias, is read inside one studio request");
  let k = 0;
  const id = () => "s" + String(k++).padStart(5, "0");
  const widestPipes = Array.from({ length: MAX_PIPELINES }, (_, i): Pipeline => ({ id: "p" + String(i).padStart(5, "0"), name: ("“" + i).padEnd(MAX_PIPELINE_NAME, "”"), stages: Array.from({ length: MAX_STAGES }, (_, j) => ({ id: id(), name: "“".repeat(MAX_STAGE_NAME), kind: j === MAX_STAGES - 2 ? "won" as const : j === MAX_STAGES - 1 ? "lost" as const : "open" as const })) }));
  widestPipes[0] = { ...widestPipes[0], moved: Object.fromEntries(Array.from({ length: MAX_STAGE_MOVES }, (_, i) => ["z" + String(i).padStart(5, "0"), widestPipes[0].stages[0].id])) };
  is("(it is a record the code keeps)", parsePipelines(widestPipes, true)?.length, MAX_PIPELINES);
  // Read back as Upstash's REST answers: the stored JSON inside a JSON string, escaped again.
  const wire = Buffer.byteLength(JSON.stringify({ result: JSON.stringify(widestPipes) }));
  is(`${wire.toLocaleString("en-US")} bytes on the wire, inside the 50,000 a studio request is priced at`, request("studio", 1, wire) <= UNIT_COST.studio && wire < 50_000, true);
  const widestWire = Buffer.byteLength(JSON.stringify(JSON.stringify(widest("d000000000", "lead00"))));
  is(`a deal record at its widest is ${widestWire.toLocaleString("en-US")} bytes on the wire, inside DEAL_WIRE_BYTES (${DEAL_WIRE_BYTES.toLocaleString("en-US")})`, widestWire <= DEAL_WIRE_BYTES, true);

  part("The whole request, in its worst cases, costs no more than the studio requests it took");
  const measure = async (owner: string, statsOf: string, body: Record<string, unknown>, who = owner) => {
    const storeNow = (await storeForEmail(owner))!;
    const usedBefore = await allowanceUsed(storeNow, "studio");
    const session = await openSession(who);
    let sent = 0, moved = 0, trips = 0;
    const tags = new Map<string, number>();
    const plain = redis.pipeline;
    let response: Response;
    try {
      redis.pipeline = async (cmds) => {
        const reply = await plain.call(redis, cmds);
        trips += 1;
        for (const c of cmds) {
          sent += 1;
          // What a script runs inside, which Upstash bills one by one: MOVE_CRM_DEAL and the pipelines' save two; any
          // other script as many as the most any runs here (TAKE_DATA with two years of months, lib/sent-links.ts).
          if (c[0] === "EVAL") {
            const tag = /-- marktmorgen:([a-z0-9-]+)/.exec(String(c[1]))?.[1] ?? "?";
            tags.set(tag, (tags.get(tag) ?? 0) + 1);
            sent += tag === "crm-deal-move" || tag === "crm-pipelines-save" ? 2 : 6 + 2 * 24;
          }
        }
        moved += Buffer.byteLength(JSON.stringify(cmds)) + Buffer.byteLength(JSON.stringify(reply));
        return reply;
      };
      response = await POST(new NextRequest("https://marktmorgen.com/api/store/crm", { method: "POST", headers: { "content-type": "application/json", cookie: SESSION_COOKIE + "=" + session }, body: JSON.stringify(body) }));
    } finally { redis.pipeline = plain; }
    const units = (await allowanceUsed(storeNow, "studio")) - usedBefore;
    const cost = crmDealScanCost(sent, moved, trips);
    void statsOf;
    return { status: response.status, body: await response.json(), units, cost, sent, moved, trips, tags: Object.fromEntries(tags) };
  };
  const report = (m: Awaited<ReturnType<typeof measure>>) => `${m.sent.toLocaleString("en-US")} commands, ${m.moved.toLocaleString("en-US")} bytes, ${m.trips} trips: $${m.cost.toFixed(6)}; ${m.units} studio requests taken, $${(m.units * UNIT_COST.studio).toFixed(6)}`;

  // (a) A restricted teammate, every alias kept, MAX_DEALS deals at their widest all in them: renaming his own
  // pipeline compacts them all.
  const a = await studioStore("aliasworsta");
  const aStats = a.store.statsId!;
  await putMember(a.store, "sam@example.com", "support");
  const mine: Pipeline = { id: "samsp1", name: "Sam's", stages: [{ id: "snew01", name: "New", kind: "open" }, { id: "swon01", name: "Won", kind: "won" }, { id: "slost1", name: "Lost", kind: "lost" }] };
  const every = Object.fromEntries(Array.from({ length: MAX_STAGE_MOVES }, (_, i) => ["a" + String(i).padStart(5, "0"), "lead00"]));
  await redis.pipeline([["SET", "nl:crm:pipes:" + aStats, JSON.stringify([{ ...sales, moved: every }, mine])], ...ids.map((id, i) => ["HSET", "nl:crm:deals:" + aStats, id, JSON.stringify(widest(id, "a" + String(i % MAX_STAGE_MOVES).padStart(5, "0")))])]);
  await writePipelineAccess(aStats, "sam@example.com", { sales0: "view" }, a.store);
  const worstA = await measure(a.owner, aStats, { action: "pipeline", pipeline: { ...mine, name: "Sam's deals" }, moves: {} }, "sam@example.com");
  is(`(a) a restricted teammate's rename with every alias kept and ${MAX_DEALS.toLocaleString("en-US")} widest deals in them: saved, the aliases compacted`, [worstA.status, (await readPipelines(aStats))[0].moved], [200, undefined]);
  is(`(a) ${report(worstA)}`, worstA.units * UNIT_COST.studio >= worstA.cost, true);

  // (b) The owner removes an empty stage with no destination, MAX_DEALS widest deals elsewhere: every one is read.
  const b = await studioStore("aliasworstb");
  const bStats = b.store.statsId!;
  await redis.pipeline(ids.map((id) => ["HSET", "nl:crm:deals:" + bStats, id, JSON.stringify(widest(id, "lead00"))]));
  const worstB = await measure(b.owner, bStats, { action: "pipeline", pipeline: { ...sales, stages: sales.stages.filter((s) => s.id !== "offr00") }, moves: {} });
  is(`(b) an empty stage removed with no destination, ${MAX_DEALS.toLocaleString("en-US")} widest deals read to show it: saved, no alias`, [worstB.status, (await readPipelines(bStats))[0].moved], [200, undefined]);
  is(`(b) ${report(worstB)}`, worstB.units * UNIT_COST.studio >= worstB.cost, true);

  // (c) The owner removes a stage with a destination, past ALIAS_COMPACT_AT aliases, every widest deal in one.
  const c = await studioStore("aliasworstc");
  const cStats = c.store.statsId!;
  const many = Object.fromEntries(Array.from({ length: ALIAS_COMPACT_AT }, (_, i) => ["c" + String(i).padStart(5, "0"), "lead00"]));
  await redis.pipeline([["SET", "nl:crm:pipes:" + cStats, JSON.stringify([{ ...sales, moved: many }])], ...ids.map((id, i) => ["HSET", "nl:crm:deals:" + cStats, id, JSON.stringify(widest(id, "c" + String(i % ALIAS_COMPACT_AT).padStart(5, "0")))])]);
  const worstC = await measure(c.owner, cStats, { action: "pipeline", pipeline: { ...sales, stages: sales.stages.filter((s) => s.id !== "talk00") }, moves: { talk00: "lead00" } });
  is(`(c) a stage removed past ${ALIAS_COMPACT_AT} aliases, ${MAX_DEALS.toLocaleString("en-US")} widest deals compacted: saved with the one alias it made`, [worstC.status, (await readPipelines(cStats))[0].moved], [200, { talk00: "lead00" }]);
  is(`(c) ${report(worstC)}`, worstC.units * UNIT_COST.studio >= worstC.cost, true);
  console.log("scripts sent:", JSON.stringify({ a: worstA.tags, b: worstB.tags, c: worstC.tags }));
  done();
}
void main();
