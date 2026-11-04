/**
 * 635 [GL3]: the deals board never overwrites what a workflow step, a
 * pipeline change or a teammate wrote after the board was loaded. A change
 * to a deal carries the version of the record the board read (dealVersion,
 * a hash of the exact stored text) and lands only over that record; anything
 * else is 409 crm_conflict with the deal as it is now, and nothing written.
 * Exercised through the real route (app/api/store/crm) on the in-memory Redis.
 */
import { NextRequest } from "next/server";
import { POST } from "@/app/api/store/crm/route";
import { SESSION_COOKIE, openSession } from "@/lib/auth";
import { MOVE_CRM_DEAL, dealSlot, dealVersion, readDealExact, readPipelines, readStages, writeDealOver } from "@/lib/crm";
import { crmAnswer } from "@/lib/crm-response";
import { redisPipeline } from "@/lib/redis";
import { dataKey } from "@/lib/store-data";
import { dataBytes } from "@/lib/store-data-rules";
import { writePipelineAccess } from "@/lib/pipeline-access";
import { claimHandle, ensureStatsId, ensureStoreId, setStripeAccount, setSubscription, storeForEmail } from "@/lib/store";
import { putMember } from "@/lib/team";
import { store as redis } from "./redis-stub";
import { paidPeriod } from "./billing-period-fixture";
import { done, is, part } from "./check";

type Reply = { ok?: boolean; error?: string; version?: string; deal?: Record<string, unknown> & { id: string }; current?: { deal: Record<string, unknown>; version: string } };

async function main(): Promise<void> {
  redis.clear();
  process.env.UPSTASH_REDIS_REST_URL ??= "http://stub";
  const owner = "deals-cas@example.com";
  await claimHandle(owner, "dealscas", "Deals CAS", "");
  await ensureStatsId(owner);
  await ensureStoreId(owner);
  await setStripeAccount(owner, "acct_1TestDealCas01", true);
  await setSubscription(owner, { customerId: "cus_DealCas0001", subscriptionId: "sub_DealCas0001", active: true, tier: "pro", period: paidPeriod() });
  const store = (await storeForEmail(owner))!;
  const statsId = store.statsId!;
  const dealsKey = "nl:crm:deals:" + statsId;
  await putMember(store, "maya@example.com", "support");
  await putMember(store, "sam@example.com", "support");
  const cookies = { owner: `${SESSION_COOKIE}=${await openSession(owner)}`, sam: `${SESSION_COOKIE}=${await openSession("sam@example.com")}` };
  const post = async (body: Record<string, unknown>, who: keyof typeof cookies = "owner") => {
    const response = await POST(new NextRequest("https://marktmorgen.com/api/store/crm", { method: "POST", headers: { "content-type": "application/json", cookie: cookies[who] }, body: JSON.stringify(body) }));
    return { status: response.status, body: (await response.json()) as Reply };
  };
  const stored = async (id: string) => (await redisPipeline([["HGET", dealsKey, id]]))[0] as string | null;
  // A workflow step's write ("rotate"): over the exact record it read, as lib/flow steps do.
  const rotate = async (id: string) => {
    const read = await readDealExact(statsId, id, await readStages(statsId));
    return writeDealOver(statsId, { ...read.deal!, assignee: "maya@example.com", nextAction: "Call Dana back", dueDate: "2026-11-10" }, read.raw!, store);
  };
  const newDeal = async (title: string, stage = "lead00") => {
    const made = await post({ action: "deal", deal: { title, email: "dana@example.com", cents: 90_000, stage, note: "First call" } });
    is(`(${title}: made, with the version of what was stored)`, [made.status, made.body.version === dealVersion((await stored(made.body.deal!.id))!)], [200, true]);
    return { id: made.body.deal!.id, version: made.body.version! };
  };

  part("The reviewer's scenario: a step writes between the board's read and its save");
  const dana = await newDeal("Six sessions for Dana");
  is("the step's write lands", await rotate(dana.id), "saved");
  const afterStep = await stored(dana.id);
  const noteOnly = await post({ action: "deal", version: dana.version, deal: { id: dana.id, note: "Sent the proposal" } });
  is("saving only the note over the old version: 409 crm_conflict", [noteOnly.status, noteOnly.body.ok, noteOnly.body.error], [409, false, "crm_conflict"]);
  is("nothing is written: the record is byte for byte what the step left", await stored(dana.id), afterStep);
  is("the board gets the deal as it is now, with its new version", [noteOnly.body.current?.deal.assignee, noteOnly.body.current?.deal.nextAction, noteOnly.body.current?.deal.dueDate, noteOnly.body.current?.version === dealVersion(afterStep!), noteOnly.body.current?.version !== dana.version], ["maya@example.com", "Call Dana back", "2026-11-10", true, true]);
  is("and the board reads it as a conflict carrying the current deal", crmAnswer(false, noteOnly.body), { ok: false, error: "crm_conflict", current: noteOnly.body.current });

  part("Sent again with the current version and only the note");
  const again = await post({ action: "deal", version: noteOnly.body.current!.version, deal: { id: dana.id, note: "Sent the proposal" } });
  const kept = JSON.parse((await stored(dana.id))!);
  is("saved", [again.status, again.body.ok], [200, true]);
  is("the note is saved; the step's assignee, next action and date are kept; the stage is untouched", [kept.note, kept.assignee, kept.nextAction, kept.dueDate, kept.stage, kept.title, kept.cents], ["Sent the proposal", "maya@example.com", "Call Dana back", "2026-11-10", "lead00", "Six sessions for Dana", 90_000]);
  is("the answer's version is the new record's", again.body.version, dealVersion((await stored(dana.id))!));

  part("The stage select, after a step wrote");
  const ben = await newDeal("Workshop for Ben");
  await rotate(ben.id);
  const beforeMove = await stored(ben.id);
  const moved = await post({ action: "deal", version: ben.version, deal: { id: ben.id, stage: "won000" } });
  is("moving it over the old version: 409", [moved.status, moved.body.error], [409, "crm_conflict"]);
  is("stage and assignee untouched", [await stored(ben.id) === beforeMove, JSON.parse(beforeMove!).stage, JSON.parse(beforeMove!).assignee], [true, "lead00", "maya@example.com"]);
  const movedNow = await post({ action: "deal", version: moved.body.current!.version, deal: { id: ben.id, stage: "won000" } });
  is("moved with the current version: only the stage changes", [movedNow.status, JSON.parse((await stored(ben.id))!).stage, JSON.parse((await stored(ben.id))!).assignee], [200, "won000", "maya@example.com"]);

  part("A change with no version, from an older tab");
  const cy = await newDeal("Coaching for Cy");
  const bare = await post({ action: "deal", deal: { id: cy.id, note: "Old tab" } });
  const before = await stored(cy.id);
  is("409, with the deal as it is now", [bare.status, bare.body.error, bare.body.current?.version], [409, "crm_conflict", cy.version]);
  is("nothing written", await stored(cy.id), before);
  is("a version that is not one: 409 too", (await post({ action: "deal", version: 42, deal: { id: cy.id, note: "Old tab" } })).status, 409);

  part("A pipeline change that moves the deal's stage (updatedAt left as it was)");
  const dee = await newDeal("Retainer for Dee", "talk00");
  const updatedBefore = JSON.parse((await stored(dee.id))!).updatedAt;
  const [sales] = await readPipelines(statsId);
  const removed = await post({ action: "pipeline", pipeline: { ...sales, stages: sales.stages.filter((s) => s.id !== "talk00") }, moves: { talk00: "lead00" } });
  const afterPipeline = JSON.parse((await stored(dee.id))!);
  is("(the stage removed, its deal moved, updatedAt unchanged)", [removed.status, afterPipeline.stage, afterPipeline.updatedAt], [200, "lead00", updatedBefore]);
  const stale = await post({ action: "deal", version: dee.version, deal: { id: dee.id, note: "Still talking" } });
  is("an edit over the version from before the move: 409, stage as moved", [stale.status, stale.body.current?.deal.stage, JSON.parse((await stored(dee.id))!).note], [409, "lead00", "First call"]);

  part("A write between the route's read and its compare-and-set");
  const eve = await newDeal("Course for Eve");
  const original = redis.pipeline;
  let raced = "";
  try {
    redis.pipeline = async (commands) => {
      const write = commands.find((c) => c[0] === "EVAL" && c[1] === MOVE_CRM_DEAL && c[3] === dealsKey && c[4] === eve.id);
      if (write && !raced) {
        const current = JSON.parse((await original.call(redis, [["HGET", dealsKey, eve.id]]))[0] as string);
        raced = JSON.stringify({ ...current, assignee: "maya@example.com", note: "Written by a step meanwhile, a longer note than before" });
        await original.call(redis, [["HSET", dealsKey, eve.id, raced]]);
      }
      return original.call(redis, commands);
    };
    const race = await post({ action: "deal", version: eve.version, deal: { id: eve.id, title: "Course for Eve, two seats" } });
    is("409, with the deal re-read after the script said it changed", [race.status, race.body.error, race.body.current?.version === dealVersion(raced), race.body.current?.deal.assignee], [409, "crm_conflict", true, "maya@example.com"]);
  } finally {
    redis.pipeline = original;
  }
  is("nothing written over the other write", await stored(eve.id), raced);
  is("the deal's room is back to what the record kept now weighs", Number((await redisPipeline([["HGET", dataKey(store)!, dealSlot(eve.id)]]))[0]), dataBytes([eve.id, raced], 1));

  part("A deal removed meanwhile");
  const flo = await newDeal("Audit for Flo");
  try {
    redis.pipeline = async (commands) => {
      if (commands.some((c) => c[0] === "EVAL" && c[1] === MOVE_CRM_DEAL && c[4] === flo.id)) await original.call(redis, [["HDEL", dealsKey, flo.id]]);
      return original.call(redis, commands);
    };
    const gone = await post({ action: "deal", version: flo.version, deal: { id: flo.id, note: "x" } });
    is("404 unknown, never brought back", [gone.status, gone.body.error, await stored(flo.id)], [404, "unknown", null]);
  } finally {
    redis.pipeline = original;
  }
  is("and one already gone: 404 unknown", [(await post({ action: "deal", version: flo.version, deal: { id: flo.id, note: "x" } })).status], [404]);

  part("What an edit costs in database requests");
  const hal = await newDeal("Plan for Hal");
  const counted = async (body: Record<string, unknown>) => {
    let calls = 0;
    const writes: string[] = [];
    redis.pipeline = async (commands) => {
      if (commands.some((c) => String(c[1] ?? "").startsWith("nl:crm:") || c[3] === dealsKey)) calls++;
      for (const c of commands) if ((c[0] === "EVAL" && c[3] === dealsKey) || (c[0] === "HSET" && c[1] === dealsKey)) writes.push(String(c[0]));
      return original.call(redis, commands);
    };
    try { return { reply: await post(body), calls, writes }; } finally { redis.pipeline = original; }
  };
  const edit = await counted({ action: "deal", version: hal.version, deal: { id: hal.id, note: "Booked" } });
  is("an edit: the stages, the record and one compare-and-set write", [edit.reply.status, edit.calls, edit.writes], [200, 3, ["EVAL"]]);
  const lost = await counted({ action: "deal", version: hal.version, deal: { id: hal.id, note: "Booked again" } });
  is("a conflict: the stages and the record, nothing written", [lost.reply.status, lost.calls, lost.writes], [409, 2, []]);

  part("Someone whose access to the pipeline is view only");
  const gus = await newDeal("Package for Gus");
  await writePipelineAccess(statsId, "sam@example.com", { [sales.id]: "view" }, store);
  const beforeView = await stored(gus.id);
  for (const version of [gus.version, "0".repeat(32), undefined]) {
    const refused = await post({ action: "deal", ...(version === undefined ? {} : { version }), deal: { id: gus.id, note: "Mine" } }, "sam");
    is(`refused with 403 before any version is compared (${version === gus.version ? "right" : version ? "wrong" : "no"} version), and the deal is never sent`, [refused.status, refused.body.error, "current" in refused.body, "deal" in refused.body], [403, "pipeline_access", false, false]);
  }
  is("nothing written", await stored(gus.id), beforeView);

  done();
}

void main();
