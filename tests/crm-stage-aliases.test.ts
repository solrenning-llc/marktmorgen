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
import { DEAL_WIRE_BYTES, PIPELINES_WIRE_BYTES, type StudioPayer, readDeal, readDealExact, readDeals, readOpportunityReview, readPipelines, readStageView, savePipelineChange, writeDeal } from "@/lib/crm";
import { ALIAS_COMPACT_AT, DEFAULT_STAGES, FIRST_PIPELINE_ID, MAX_DEALS, MAX_DEAL_NOTE, MAX_DEAL_TITLE, MAX_PIPELINES, MAX_PIPELINE_NAME, MAX_STAGES, MAX_STAGE_MOVES, MAX_STAGE_NAME, type Deal, type Pipeline, copyPipeline, nextStageMoves, parseDeal, parsePipelines } from "@/lib/crm-rules";
import { crmAnswer } from "@/lib/crm-response";
import { writePipelineAccess } from "@/lib/pipeline-access";
import { claimHandle, ensureListId, ensureStatsId, ensureStoreId, setStripeAccount, setSubscription, storeForEmail } from "@/lib/store";
import { allowanceUsed } from "@/lib/store-allowance";
import { STORE_ALLOWANCES } from "@/lib/store-allowance-rules";
import { TEAM_LOG_COMMANDS, putMember } from "@/lib/team";
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
/** A payer for the library's own calls: counts what it is asked for, and stops paying past `most` studio requests. */
const paying = (most = Number.POSITIVE_INFINITY, counts = true) => {
  const book = { taken: 0, forced: 0, takes: 0, given: 0 };
  const payer: StudioPayer = {
    take: async (units) => {
      if (book.taken + units > most) return { ok: false, reason: "used", message: "This opens again on December 1 (UTC)." };
      book.takes += 1;
      book.taken += units;
      return { ok: true };
    },
    force: async (units) => {
      if (!counts) return false;
      book.forced += units;
      return true;
    },
    give: async (units) => { book.given += units; book.taken -= units; },
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

  part("A stage removed with no destination goes only once its deals, read and paid for, show it holds none; it keeps an alias too");
  // Coordinator's 6aeb and HIGH on 2e9cc22f25: a stage that holds deals and no destination is refused, as on main, so
  // the deals are counted first; one shown empty keeps an alias to the first open stage kept in its pipeline.
  const withoutOffer = { ...sales, stages: sales.stages.filter((s) => s.id !== "offr00") };
  const unread = paying();
  const goneOffer = await savePipelineChange(statsId, { pipeline: withoutOffer }, {}, 2, ROOM, unread.payer);
  is("Offer sent, shown empty, goes, shown in New, the first open stage kept in Sales, its deals read and paid for first", [goneOffer.ok && goneOffer.moves, (await readPipelines(statsId))[0].moved, unread.book.takes > 0, unread.book.forced], [{ offr00: "lead00" }, { ccall0: "cnew00", cprop0: "cnew00", offr00: "lead00" }, true, 0]);

  part("A pipeline removed with no destination goes only once its deals, read and paid for, show it holds none");
  const recordNow = (await redis.pipeline([["GET", pipesKey]]))[0];
  is("not paid for: refused, nothing written (the deals are never read for free)", [await savePipelineChange(statsId, { remove: "coach0" }, "", 2, ROOM), (await redis.pipeline([["GET", pipesKey]]))[0] === recordNow], [{ ok: false, error: "unavailable", message: "This can't be counted right now. Try again in a minute." }, true]);
  const held = paying();
  is("paid: Coaching, where every deal shows, is refused with nothing written", [await savePipelineChange(statsId, { remove: "coach0" }, "", 2, ROOM, held.payer), (await redis.pipeline([["GET", pipesKey]]))[0] === recordNow], [{ ok: false, error: "moves" }, true]);
  is(`the read took its studio requests first (${held.book.taken} kept for ${MAX_DEALS.toLocaleString("en-US")} deals, ${held.book.given} given back as the records were smaller than the most they can weigh), and nothing past them`, [held.book.taken > 0, held.book.forced], [true, 0]);

  part(`Past ${ALIAS_COMPACT_AT} aliases, the deals kept in older ones are written where they show and those aliases go`);
  // The record with every alias it may keep: the deals in ccall0 and cprop0, offr00 that holds none, and 197 more.
  const older = Object.fromEntries(Array.from({ length: MAX_STAGE_MOVES - 3 }, (_, i) => ["z" + String(i).padStart(5, "0"), "cnew00"]));
  const pipes = JSON.parse(String((await redis.pipeline([["GET", pipesKey]]))[0])) as Pipeline[];
  pipes[0] = { ...pipes[0], moved: { ...pipes[0].moved, ...older } };
  await redis.pipeline([["SET", pipesKey, JSON.stringify(pipes)]]);
  // A hundred deals kept in the older aliases too, one in each of the first hundred.
  await redis.pipeline(ids.slice(0, 100).map((id, i) => ["HSET", dealsKey, id, JSON.stringify({ ...deal(id, "z" + String(i).padStart(5, "0")), futureMetadata: { kept: i } })]));
  const shownBefore = (await readDeals(statsId, await readStageView(statsId))).map((d) => [d.id, d.stage]).sort();
  const recordBefore = (await redis.pipeline([["GET", pipesKey]]))[0];
  const withoutTalking = { ...sales, stages: withoutOffer.stages.filter((s) => s.id !== "talk00") };
  const short = paying(30);
  const spent = await savePipelineChange(statsId, { pipeline: withoutTalking }, { talk00: "lead00" }, 2, ROOM, short.payer);
  const written = (await redis.pipeline([["HVALS", dealsKey]]))[0] as string[];
  const rewritten = written.filter((raw) => ["cnew00"].includes(JSON.parse(raw).stage)).length;
  is("the allowance spent part way: refused with the figure's words (when it opens again), the pipelines as they were", [spent, (await redis.pipeline([["GET", pipesKey]]))[0] === recordBefore], [{ ok: false, error: "studio_used", message: "This opens again on December 1 (UTC)." }, true]);
  is(`the batches paid for were written (${rewritten} of ${MAX_DEALS.toLocaleString("en-US")}), whole batches, the rest left in their aliases`, [rewritten > 0 && rewritten < MAX_DEALS && rewritten % 100 === 0, written.length], [true, MAX_DEALS]);
  is("and every deal still shows where it did", (await readDeals(statsId, await readStageView(statsId))).map((d) => [d.id, d.stage]).sort(), shownBefore);
  const full = paying();
  const compacted = await savePipelineChange(statsId, { pipeline: withoutTalking }, { talk00: "lead00" }, 2, ROOM, full.payer);
  is("paid in full: saved, with only the alias of the stage removed now", [compacted.ok, (await readPipelines(statsId))[0].moved], [true, { talk00: "lead00" }]);
  is("every deal is written in the stage it showed in", (await readDeals(statsId, await readStageView(statsId))).map((d) => [d.id, d.stage]).sort(), shownBefore);
  const sample = JSON.parse(String((await redis.pipeline([["HGET", dealsKey, ids[7]]]))[0]));
  is("with its updatedAt and every other field, unknown ones too, as they were", sample, { ...deal(ids[7], "cnew00"), futureMetadata: { kept: 7 } });
  is("and no workflow, reminder or webhook started: the compaction never reaches lib/deal-stage-trigger.ts", /from "@\/lib\/deal-stage-trigger"|dealEnteredStage\(/.test(readFileSync("lib/crm.ts", "utf8")), false);

  part("A record wider than DEAL_WIRE_BYTES: what it weighed past what was paid is counted before anything more is read");
  const x = await studioStore("aliaswide");
  const xStats = x.store.statsId!;
  await redis.pipeline([["SET", "nl:crm:pipes:" + xStats, JSON.stringify([sales, coaching])], ...ids.slice(0, 50).map((id) => ["HSET", "nl:crm:deals:" + xStats, id, JSON.stringify(deal(id, "lead00"))]), ["HSET", "nl:crm:deals:" + xStats, ids[50], JSON.stringify({ ...deal(ids[50], "lead00"), olderField: "x".repeat(3_000_000) })]]);
  const xRecord = (await redis.pipeline([["GET", "nl:crm:pipes:" + xStats]]))[0];
  const wide = paying();
  is("an older record of 3 MB: the empty pipeline goes, and the excess is counted at once", [(await savePipelineChange(xStats, { remove: "coach0" }, "", 2, ROOM, wide.payer)).ok, wide.book.forced > 0], [true, true]);
  await redis.pipeline([["SET", "nl:crm:pipes:" + xStats, xRecord as string]]);
  const unconfirmed = paying(Number.POSITIVE_INFINITY, false);
  is("a count of the excess that is not confirmed: refused, nothing written", [await savePipelineChange(xStats, { remove: "coach0" }, "", 2, ROOM, unconfirmed.payer), (await redis.pipeline([["GET", "nl:crm:pipes:" + xStats]]))[0] === xRecord], [{ ok: false, error: "unavailable", message: "This can't be counted right now, so nothing was changed. Try again in a minute." }, true]);

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
  is(`and inside PIPELINES_WIRE_BYTES (${PIPELINES_WIRE_BYTES.toLocaleString("en-US")}), which a change that reads the deals pays for four times`, wire <= PIPELINES_WIRE_BYTES, true);
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
          // What a script runs inside, which Upstash bills one by one: MOVE_CRM_DEAL and the pipelines' save two, the
          // activity line's fence its GET, HEXISTS, LPUSH and LTRIM (lib/team.ts TEAM_LOG_COMMANDS, less its own GET and
          // EVAL), a give-back its EXISTS, DECRBY and INCRBY; any other as many as the most any runs here (TAKE_DATA with
          // two years of months, lib/sent-links.ts).
          if (c[0] === "EVAL") {
            const tag = /-- marktmorgen:([a-z0-9-]+)/.exec(String(c[1]))?.[1] ?? "?";
            tags.set(tag, (tags.get(tag) ?? 0) + 1);
            sent += tag === "crm-deal-move" || tag === "crm-pipelines-save" ? 2 : tag === "team-log-live" ? TEAM_LOG_COMMANDS - 2 : tag === "allowance-give-back" ? 3 : 6 + 2 * 24;
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
  // Both ends (the coordinator's decision on #5128): the studio requests taken cover the cost with the registry's 5%
  // room (as API_SALES_UNITS and the plan invoices keep it), and are never more than that room past the fewest that do,
  // or one request where the room is less than one.
  const fewest = (m: Awaited<ReturnType<typeof measure>>) => Math.ceil((1.05 * m.cost) / UNIT_COST.studio);
  const report = (m: Awaited<ReturnType<typeof measure>>) => `${m.sent.toLocaleString("en-US")} commands, ${m.moved.toLocaleString("en-US")} bytes, ${m.trips} trips: $${m.cost.toFixed(6)}, $${(1.05 * m.cost).toFixed(6)} with its room (${fewest(m)} studio requests at the fewest); ${m.units} taken, $${(m.units * UNIT_COST.studio).toFixed(6)}`;
  const bothEnds = (m: Awaited<ReturnType<typeof measure>>) => m.units * UNIT_COST.studio >= 1.05 * m.cost && m.units <= fewest(m) + Math.max(1, Math.floor(0.05 * fewest(m)));

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
  is(`(a) ${report(worstA)}`, bothEnds(worstA), true);
  is("(a) the answer says how many studio requests it used, for the board to tell the creator", worstA.body.studioRequestsUsed, worstA.units);

  // (b) The owner removes an empty pipeline with no destination, MAX_DEALS widest deals elsewhere: every one is read.
  const b = await studioStore("aliasworstb");
  const bStats = b.store.statsId!;
  await redis.pipeline([["SET", "nl:crm:pipes:" + bStats, JSON.stringify([sales, coaching])], ...ids.map((id) => ["HSET", "nl:crm:deals:" + bStats, id, JSON.stringify(widest(id, "lead00"))])]);
  const worstB = await measure(b.owner, bStats, { action: "unpipeline", id: "coach0", moveTo: "" });
  is(`(b) an empty pipeline removed with no destination, ${MAX_DEALS.toLocaleString("en-US")} widest deals read to show it: removed, its stages shown in New`, [worstB.status, (await readPipelines(bStats)).map((p) => p.id), Object.values((await readPipelines(bStats))[0].moved ?? {})], [200, ["sales0"], ["lead00", "lead00", "lead00", "lead00", "lead00"]]);
  is(`(b) ${report(worstB)}`, bothEnds(worstB), true);
  is("(b) the deals were read, so the answer says how many studio requests that used", worstB.body.studioRequestsUsed, worstB.units);

  // (b2) The same read over MAX_DEALS ordinary deals: paid at the most a record can weigh, then put right by what the
  // records really moved, so it ends at the fewest that cover its cost too.
  const b2 = await studioStore("aliasworstb2");
  const b2Stats = b2.store.statsId!;
  await redis.pipeline([["SET", "nl:crm:pipes:" + b2Stats, JSON.stringify([sales, coaching])], ...ids.map((id) => ["HSET", "nl:crm:deals:" + b2Stats, id, JSON.stringify(deal(id, "lead00"))])]);
  const ordinary = await measure(b2.owner, b2Stats, { action: "unpipeline", id: "coach0", moveTo: "" });
  is(`(b2) ordinary deals: removed`, ordinary.status, 200);
  is(`(b2) ${report(ordinary)}`, bothEnds(ordinary), true);

  // (c) The owner removes a stage with a destination, past ALIAS_COMPACT_AT aliases, every widest deal in one.
  const c = await studioStore("aliasworstc");
  const cStats = c.store.statsId!;
  const many = Object.fromEntries(Array.from({ length: ALIAS_COMPACT_AT }, (_, i) => ["c" + String(i).padStart(5, "0"), "lead00"]));
  await redis.pipeline([["SET", "nl:crm:pipes:" + cStats, JSON.stringify([{ ...sales, moved: many }])], ...ids.map((id, i) => ["HSET", "nl:crm:deals:" + cStats, id, JSON.stringify(widest(id, "c" + String(i % ALIAS_COMPACT_AT).padStart(5, "0")))])]);
  const worstC = await measure(c.owner, cStats, { action: "pipeline", pipeline: { ...sales, stages: sales.stages.filter((s) => s.id !== "talk00") }, moves: { talk00: "lead00" } });
  is(`(c) a stage removed past ${ALIAS_COMPACT_AT} aliases, ${MAX_DEALS.toLocaleString("en-US")} widest deals compacted: saved with the one alias it made`, [worstC.status, (await readPipelines(cStats))[0].moved], [200, { talk00: "lead00" }]);
  is(`(c) ${report(worstC)}`, bothEnds(worstC), true);
  is("(c) the answer says how many studio requests it used", worstC.body.studioRequestsUsed, worstC.units);

  // (e) Every alias kept and none held by a deal (every removed stage keeps one, empty or not): the compaction only
  // reads, rewrites nothing, and drops them all, so the cap never locks.
  const e = await studioStore("aliasworste");
  const eStats = e.store.statsId!;
  const empties = Object.fromEntries(Array.from({ length: MAX_STAGE_MOVES }, (_, i) => ["e" + String(i).padStart(5, "0"), "lead00"]));
  await redis.pipeline([["SET", "nl:crm:pipes:" + eStats, JSON.stringify([{ ...sales, moved: empties }])], ...ids.map((id) => ["HSET", "nl:crm:deals:" + eStats, id, JSON.stringify(widest(id, "lead00"))])]);
  const worstE = await measure(e.owner, eStats, { action: "pipeline", pipeline: { ...sales, stages: sales.stages.filter((s) => s.id !== "talk00") }, moves: { talk00: "lead00" } });
  is(`(e) ${MAX_STAGE_MOVES} empty aliases and ${MAX_DEALS.toLocaleString("en-US")} widest deals: saved, nothing rewritten, only the alias it made kept`, [worstE.status, worstE.tags["crm-deal-move"] ?? 0, (await readPipelines(eStats))[0].moved], [200, 0, { talk00: "lead00" }]);
  is(`(e) ${report(worstE)}`, bothEnds(worstE), true);

  part("A compaction the month's studio requests run out in: 429, nothing lost, and when they open again");
  const d = await studioStore("aliasworstd");
  const dStats = d.store.statsId!;
  await redis.pipeline([["SET", "nl:crm:pipes:" + dStats, JSON.stringify([{ ...sales, moved: many }])], ...ids.map((id, i) => ["HSET", "nl:crm:deals:" + dStats, id, JSON.stringify(deal(id, "c" + String(i % ALIAS_COMPACT_AT).padStart(5, "0")))])]);
  const dShown = (await readDeals(dStats, await readStageView(dStats))).map((x) => [x.id, x.stage]).sort();
  const dRecord = (await redis.pipeline([["GET", "nl:crm:pipes:" + dStats]]))[0];
  // The store's figure for the month, all but a few: a whole request is let in, the compaction runs out part way.
  const dSession = await openSession(d.owner);
  const dPost = async (body: Record<string, unknown>) => {
    const r = await POST(new NextRequest("https://marktmorgen.com/api/store/crm", { method: "POST", headers: { "content-type": "application/json", cookie: SESSION_COOKIE + "=" + dSession }, body: JSON.stringify(body) }));
    return { status: r.status, body: await r.json() };
  };
  is("(a first request, so the month's counter is there)", (await dPost({ action: "pipeline", pipeline: { ...sales, name: "Sales" }, moves: {} })).status, 200);
  const counters = ((await redis.pipeline([["SCAN", "0", "MATCH", "nl:allow:studio:*", "COUNT", "10000"]]))[0] as [string, string[]])[1];
  const limit = STORE_ALLOWANCES.pro.studio;
  for (const key of counters) await redis.pipeline([["SET", key, String(limit - 20)], ["EXPIRE", key, 86_400]]);
  const ranOut = await dPost({ action: "pipeline", pipeline: { ...sales, stages: sales.stages.filter((s) => s.id !== "talk00") }, moves: { talk00: "lead00" } });
  const answer = crmAnswer(false, ranOut.body);
  is("429 studio_used, with the figure's own words, which say when it opens again", [ranOut.status, ranOut.body.error, typeof ranOut.body.message === "string" && /opens again/.test(ranOut.body.message), answer.ok === false && answer.message === ranOut.body.message], [429, "studio_used", true, true]);
  is("nothing lost: the pipelines as they were, and every deal shown where it was", [(await redis.pipeline([["GET", "nl:crm:pipes:" + dStats]]))[0] === dRecord, (await readDeals(dStats, await readStageView(dStats))).map((x) => [x.id, x.stage]).sort()], [true, dShown]);
  const boardFile = readFileSync("components/deals-board.tsx", "utf8");
  is("the board says it in plain words, with the server's words for when", boardFile.includes("Nothing was saved, and nothing was lost: your pipelines, stages and deals did not change.") && boardFile.includes("} ${answer.message}`"), true);
  is("and, after a compaction, how many requests it used, never the limits", [boardFile.includes("Checking your deals for this used ${used.toLocaleString(\"en-US\")} of this month's studio requests."), /\b(150|200)\b/.test(boardFile.split("\n").filter((line) => line.includes("studio requests")).join("\n"))], [true, false]);
  console.log("scripts sent:", JSON.stringify({ a: worstA.tags, b: worstB.tags, c: worstC.tags }));
  done();
}
void main();
