/**
 * Codex X6 on #3678 (MEDIUM, personal-data erasure): a team log line written while its store is being erased made the
 * deleted log again, with a teammate's address in it, after dropTeam's DEL. logTeam now pushes the line only inside
 * LOG_IF_LIVE: the store's id key still holds its ref and its erasing mark is absent. Synthetic store, in-memory Redis.
 */
import { logTeam, readLog } from "@/lib/team";
import { type Store, ERASING_KEY, claimHandle, ensureListId, ensureStatsId, ensureStoreId, erasingField, storeForEmail, storeRef } from "@/lib/store";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";

process.env.NIMBUS_DATA_KEY ??= "tests-only-not-a-real-deployment-secret";
globalThis.fetch = (async () => new Response("{}", { status: 404 })) as typeof fetch;

const OWNER = "fence-owner@example.com";
const MATE = "fence-mate@example.com";
const logKey = (sid: string) => `nl:team:log:${sid}`;

const realPipeline = redis.pipeline.bind(redis);
let beforeFence: (() => Promise<void>) | null = null;
(redis as unknown as { pipeline: typeof realPipeline }).pipeline = async (commands) => {
  const fenced = commands.some((c) => String(c[0]) === "EVAL" && String(c[1]).startsWith("-- marktmorgen:team-log-if-live:v1\n"));
  if (fenced && beforeFence) {
    const run = beforeFence;
    beforeFence = null;
    await run();
  }
  return realPipeline(commands);
};

async function liveStore(owner: string, handle: string): Promise<Store> {
  await claimHandle(owner, handle, "Fence Goods", "");
  await ensureStatsId(owner);
  await ensureStoreId(owner);
  await ensureListId(owner);
  return (await storeForEmail(owner))!;
}

async function exists(key: string): Promise<boolean> {
  const [n] = await realPipeline([["EXISTS", key]]);
  return Number(n) === 1;
}

async function main(): Promise<void> {
  redis.clear();
  const store = await liveStore(OWNER, "fencegoods");
  const sid = store.sid!;

  part("A live store: the line is written, as before");
  is("written, and said so", await logTeam(sid, { who: MATE, role: "admin", what: "Refunded $5" }), true);
  is("the line is in the log", (await readLog(sid))?.map((l) => l.who), [MATE]);

  part("A ref handed in by the caller (lib/studio-route.ts): written in one trip, and only while it is still the store's");
  is("the store's own ref: written", await logTeam(sid, { who: MATE, role: "admin", what: "Saved a product" }, storeRef(store)), true);
  is("a ref that is not the store's: not written", await logTeam(sid, { who: MATE, role: "admin", what: "Saved a product" }, "someone-else@example.com"), false);
  is("two lines in the log", (await readLog(sid))?.length, 2);

  part("The store's erasure starts between the ref's read and the write: nothing is written, the log stays deleted");
  beforeFence = async () => {
    await realPipeline([["HSET", ERASING_KEY, await erasingField(storeRef(store)), "1"], ["DEL", logKey(sid)]]);
  };
  is("not written, and said so", await logTeam(sid, { who: MATE, role: "admin", what: "Refunded $6" }), false);
  is("the deleted log is not made again", await exists(logKey(sid)), false);

  part("Erasing mark already there: nothing is written");
  is("not written", await logTeam(sid, { who: MATE, role: "admin", what: "Refunded $7" }), false);
  is("no log", await exists(logKey(sid)), false);

  part("The store's id gone, or another store's ref under it: nothing is written");
  await realPipeline([["HDEL", ERASING_KEY, await erasingField(storeRef(store))]]);
  beforeFence = async () => {
    await realPipeline([["SET", `nl:store:id:${sid}`, "someone-else@example.com"]]);
  };
  is("another ref under the id: not written", await logTeam(sid, { who: MATE, role: "admin", what: "Refunded $8" }), false);
  is("still no log", await exists(logKey(sid)), false);
  await realPipeline([["DEL", `nl:store:id:${sid}`]]);
  is("no id at all: not written", await logTeam(sid, { who: MATE, role: "admin", what: "Refunded $9" }), false);
  is("and no log made for it", await exists(logKey(sid)), false);

  done();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
