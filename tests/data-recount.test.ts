import { PATH_BOARD_KEY, PATH_BOARD_OWNERS_KEY } from "@/lib/path-board";
/**
 * The one-time count of what every store already keeps (lib/data-recount.ts):
 * the families it measures are the registry's, every key of a counted family
 * is found by the store whose ids name it, each store's room ends at least as
 * full as what was measured and never emptier, a second run changes nothing,
 * and a page another run has moved past is never added twice. Runs the real
 * code against the in-memory Redis; scripts/test_data_recount_redis.py runs
 * the page's script on a real Redis.
 */
import { COUNTED_FAMILIES, ELSEWHERE_FAMILIES, countedInRoom } from "@/lib/data-families";
import { IDS_KEY, LEGACY_SLOT, RECOUNT_PAGE, RECOUNT_RUNS_PER_DAY, STATE_KEY, SUM_KEY, idsIn, measureKey, recountStep } from "@/lib/data-recount";
import { DataCountUnconfirmed, RECOUNT_AGAIN_FIELD, dataKey, dataUsed, giveData, noteData } from "@/lib/store-data";
import { claimHandle, ensureListId, ensureStatsId, ensureStoreId, setSubscription, storeForEmail } from "@/lib/store";
import { readFileSync } from "node:fs";
import { FAMILIES } from "./store-data-registry";
import { NOT_A_COST } from "./plan-cost-registry";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";
import { paidPeriod } from "./billing-period-fixture";

async function main() {
  part("What is measured is what the registry counts in the room");
  const counted = new Set<string>(), other = new Set<string>();
  for (const [name, family] of Object.entries(FAMILIES)) {
    const prefix = name.slice(0, name.indexOf("@"));
    const inRoom = Boolean(family.room?.length) || (family.parts ?? []).some((p) => "kept" in p || "item" in p);
    (inRoom ? counted : other).add(prefix);
  }
  for (const prefix of counted) other.delete(prefix);
  is("the families the room counts", [...COUNTED_FAMILIES].sort(), [...counted].sort());
  is("and every other one", [...ELSEWHERE_FAMILIES].sort(), [...other].sort());
  is("a key is its longest family's", [countedInRoom("nl:blog:body:abc:post"), countedInRoom("nl:aff:link:abc"), countedInRoom("nl:aff:0123456789abcdef0123456789abcdef:sales"), countedInRoom("nl:rl:anything")], [true, false, true, false]);
  is("ids are long, with a digit or all hex; words are not", idsIn("nl:blog:body:0123456789abcdef0123456789abcdef:post", "information storefront", "prod_9xQ2pL7mN4kR"), ["0123456789abcdef0123456789abcdef", "prod_9xQ2pL7mN4kR"]);

  part("A store's keys from before its room counted them");
  redis.clear();
  const OWNER = "recount@example.com";
  await claimHandle(OWNER, "recount", "Recount", "");
  await ensureStatsId(OWNER);
  await ensureListId(OWNER);
  await ensureStoreId(OWNER);
  await setSubscription(OWNER, { customerId: "cus_Recount001", subscriptionId: "sub_Recount001", active: true, tier: "creator", period: paidPeriod() });
  const store = (await storeForEmail(OWNER))!;
  const statsId = store.statsId!;
  const blog = `nl:blog:body:${statsId}:p1`;
  const leads = `nl:store:leads:${store.listId}`;
  const link = "nl:upd:stop:" + "f".repeat(40);
  redis.run(["SET", blog, "x".repeat(4_000)]);
  redis.run(["HSET", leads, "ana@example.com", JSON.stringify({ agreed: true, titles: ["A guide"] })]);
  redis.run(["HSET", leads, "ben@example.com", JSON.stringify({ agreed: false, titles: ["A course"] })]);
  redis.run(["SET", link, JSON.stringify({ s: statsId, e: "ana@example.com", h: "recount" })]);
  // The shared indexes were charged from their first write; never walk the whole board here.
  redis.run(["ZADD",PATH_BOARD_KEY,4,"a".repeat(32)+":4:1792380000000"]);
  redis.run(["HSET",PATH_BOARD_OWNERS_KEY,store.sid,"a".repeat(32)+":4:1792380000000"]);
  // Not the room's: a rate count, and another store's record.
  redis.run(["SET", `nl:rl:x:${statsId}`, "3"]);
  redis.run(["SET", `nl:blog:body:${"9".repeat(32)}:p1`, "y".repeat(5_000)]);
  // What the room already counts: a page saved since.
  await noteData(store, [{ slot: "p:saved", bytes: 1_000, set: true }]);
  const weights = await Promise.all([blog, leads, link].map((key) => measureKey(key)));
  const measured = weights.reduce<number>((sum, n) => sum + (n ?? 0), 0);
  const before = (await dataUsed(store))!.used;

  const first = await recountStep(Date.now() + 30_000);
  is("one run reads every store, every page and sets every room", [first.done, first.stores, first.applied], [true, 1, 1]);
  const used = (await dataUsed(store))!.used;
  const legacy = Number(redis.run(["HGET", dataKey(store)!, LEGACY_SLOT]));
  is("the slot holds what was measured beyond what the room counted: a rate count and another store's record are not this store's", legacy, measured - before);
  is("so the room is at least what was measured, and was never made emptier", [used >= measured, used >= before], [true, true]);
  is("the job's own keys are gone, and it says it is done", [redis.run(["EXISTS", IDS_KEY]), redis.run(["EXISTS", SUM_KEY]), redis.run(["HGET", STATE_KEY, "phase"])], [0, 0, "done"]);

  part("Idempotent and resumable");
  const again = await recountStep(Date.now() + 30_000);
  is("a run after it is done changes nothing", [again.done, again.pages, (await dataUsed(store))!.used], [true, 0, used]);
  // Counted again from the start, as a new version would: the same room.
  redis.run(["HSET", STATE_KEY, "version", "older"]);
  const recount = await recountStep(Date.now() + 30_000);
  is("counted twice, the room is what it was after once", [recount.done, (await dataUsed(store))!.used], [true, used]);
  redis.run(["HSET", STATE_KEY, "phase", "scan", "cursor", "17"]);
  const [stale] = await (await import("@/lib/redis")).redisPipeline([["EVAL", RECOUNT_PAGE, 2, STATE_KEY, SUM_KEY, "5", "9", OWNER, 100]]);
  is("a page read from where the job no longer is adds nothing", [stale, redis.run(["HGET", SUM_KEY, OWNER])], [0, null]);
  const [moved] = await (await import("@/lib/redis")).redisPipeline([["EVAL", RECOUNT_PAGE, 2, STATE_KEY, SUM_KEY, "17", "0", OWNER, 100]]);
  is("the page from where it is adds once and moves on", [moved, redis.run(["HGET", SUM_KEY, OWNER]), redis.run(["HGET", STATE_KEY, "phase"])], [1, "100", "apply"]);
  is("a run out of time does nothing and loses nothing", (await recountStep(Date.now() - 1)).applied, 0);

  part("A count that could not be made is made again (giveData and noteData never swallow it)");
  const finished = await recountStep(Date.now() + 30_000);
  is("the count is done before what follows", finished.done, true);
  // A record written as a job writes it, counted after: the count's own call fails once, on the network.
  const late = `nl:blog:body:${statsId}:p2`;
  redis.run(["SET", late, "z".repeat(3_000)]);
  const unnoted = (await dataUsed(store))!.used;
  const real = redis.pipeline;
  let lost = 0;
  const failCounts = () => {
    redis.pipeline = async (commands) => {
      if (commands.some((c) => c[0] === "EVAL" && String(c[1]).startsWith("-- marktmorgen:store-data:v1"))) {
        lost += 1;
        throw new Error("fetch failed");
      }
      return real(commands);
    };
  };
  failCounts();
  let noted: unknown = null;
  try {
    await noteData(store, [{ slot: "bl:p2", bytes: 3_000, set: true }]);
  } catch (error) {
    noted = error;
  }
  redis.pipeline = real;
  is("the count failed, and the record it follows is not in the room yet", [lost, (await dataUsed(store))!.used], [1, unnoted]);
  is("the caller is not stopped: the count is asked to be made again", [noted, Number(redis.run(["HGET", STATE_KEY, RECOUNT_AGAIN_FIELD])) > 0], [null, true]);
  const recounted = await recountStep(Date.now() + 30_000);
  const kept = (await Promise.all([blog, leads, link, late].map((key) => measureKey(key)))).reduce<number>((sum, n) => sum + (n ?? 0), 0);
  is("the next run counts every store again, so the room holds what the store keeps", [recounted.done, recounted.applied, (await dataUsed(store))!.used >= kept], [true, 1, true]);
  is("and the ask is spent: the run after reads and does nothing", [Number(redis.run(["HGET", STATE_KEY, RECOUNT_AGAIN_FIELD])), (await recountStep(Date.now() + 30_000)).pages], [0, 0]);

  // A give-back that sets a slot may grow it (lib/crm.ts sets it to what the record now weighs): asked again too.
  failCounts();
  const given = await giveData(store, [{ slot: "bl:p2", bytes: 9_000, set: true }]);
  const shrunk = await giveData(store, [{ slot: "bl:p2", bytes: 100 }]);
  redis.pipeline = real;
  is("a give-back not made says so, and never throws", [given, shrunk], [false, false]);
  is("one that may have grown a slot asks for the count again; one that only shrinks leaves the room fuller, never emptier", Number(redis.run(["HGET", STATE_KEY, RECOUNT_AGAIN_FIELD])), 1);
  await recountStep(Date.now() + 30_000);

  redis.pipeline = async () => {
    throw new Error("fetch failed");
  };
  let unasked: unknown = null;
  try {
    await noteData(store, [{ slot: "bl:p3", bytes: 1_000 }]);
  } catch (error) {
    unasked = error;
  }
  redis.pipeline = real;
  is("when not even the ask can be written, the caller is told and does not go on as if it were counted", [unasked instanceof DataCountUnconfirmed, unasked instanceof Error], [true, true]);
  redis.run(["HSET", STATE_KEY, RECOUNT_AGAIN_FIELD, "x"]);
  const unreadable = await recountStep(Date.now() + 30_000);
  is("an ask that cannot be read is a count made again, and set back to none", [unreadable.done, unreadable.applied, redis.run(["HGET", STATE_KEY, RECOUNT_AGAIN_FIELD])], [true, 1, "0"]);

  part("What counting again may cost at most, and where that cost is counted (rule 24, MR)");
  // However many counts fail, the asks are one number: one count made again once the one running is done, never one each.
  const startedBefore = redis.run(["HGET", STATE_KEY, "started"]);
  for (let i = 0; i < 25; i += 1) redis.run(["HINCRBY", STATE_KEY, RECOUNT_AGAIN_FIELD, 1]);
  const many = await recountStep(Date.now() + 30_000, Date.now() + 1);
  const after = await recountStep(Date.now() + 30_000);
  is("twenty-five asks start one count again, and the run after reads nothing", [many.done, redis.run(["HGET", STATE_KEY, "started"]) !== startedBefore, redis.run(["HGET", STATE_KEY, RECOUNT_AGAIN_FIELD]), after.pages, after.applied, after.stores], [true, true, "0", 0, 0, 0]);
  // So a month holds at most one run an hour (the schedule, one at a time under its lock), each held to its pages and its minute.
  const crons = (JSON.parse(readFileSync("vercel.json", "utf8")) as { crons: { path: string; schedule: string }[] }).crons.filter((c) => c.path === "/api/cron/recount");
  is("the count is run once an hour at the most, as RECOUNT_RUNS_PER_DAY says", [crons.length, /^[0-5]?[0-9] \* \* \* \*$/.test(crons[0]?.schedule ?? ""), RECOUNT_RUNS_PER_DAY, RECOUNT_RUNS_PER_DAY * 31], [1, true, 24, 744]);
  is("one run at a time, under a lock longer than a run may last", [readFileSync("app/api/cron/recount/route.ts", "utf8").includes('["SET", "nl:recount:lock", "1", "NX", "EX", 120]'), /export const maxDuration = 60;/.test(readFileSync("app/api/cron/recount/route.ts", "utf8"))], [true, true]);
  const entry = NOT_A_COST.RECOUNT_RUNS_PER_DAY;
  is("its worst month is in the cost registry, as the company's, never a plan's and never zero", [typeof entry, ...["744", "RECOUNT_PAGES", "RECOUNT_PAGE_KEYS", "company fixed cost", "never zero", "lib/llc-fixed-costs.ts"].map((word) => (entry ?? "").includes(word))], ["string", true, true, true, true, true, true]);
  done();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
