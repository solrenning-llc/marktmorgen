/**
 * Sweep A2 proof (CX-123 rule 24), synthetic only. lib/data-recount.ts (run every few minutes by
 * app/api/cron/recount):
 * 1. readState, lines 102-105: an HMGET reply that is not an array reads as phase "", version "", so recountStep
 *    (line 242-245) takes the finished recount for an old version: it DELs its progress and starts the whole
 *    keyspace walk again (SCAN of every key, paid per command), and re-sets every store's "legacy" room slot.
 * 2. applySums, lines 220-224: the store's room read (HMGET "#", "legacy") answering in an unknown shape counts as
 *    total 0, so the legacy slot is set to the whole measured weight on top of what the room already counts: the
 *    store's data room is charged twice (it may be refused writes as "full").
 */
import { LEGACY_SLOT, RECOUNT_VERSION, STATE_KEY, SUM_KEY, recountStep } from "@/lib/data-recount";
import { dataKey, noteData } from "@/lib/store-data";
import { claimHandle, ensureStatsId, ensureStoreId, storeForEmail } from "@/lib/store";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";

const original = redis.pipeline.bind(redis);
const stateOf = async () => (await original([["HMGET", STATE_KEY, "phase", "version"]]))[0];

async function main() {
  redis.clear();
  part("1. Healthy control: a finished recount stays finished");
  await original([["HSET", STATE_KEY, "phase", "done", "cursor", "0", "version", RECOUNT_VERSION, "finished", 1]]);
  const healthy = await recountStep(Date.now());
  is("done, state untouched", [healthy.done, await stateOf()], [true, ["done", RECOUNT_VERSION]]);

  part("1. DEFECT: the state read answers in an unknown shape");
  let once = true;
  redis.pipeline = (async (commands: (string | number)[][]) => {
    if (once && commands[0]?.[0] === "HMGET" && commands[0][1] === STATE_KEY) { once = false; return [null]; }
    return original(commands);
  }) as typeof redis.pipeline;
  const restarted = await recountStep(Date.now());
  redis.pipeline = original;
  is("DEFECT: the finished recount was reset to its first phase (the whole walk starts again)", [restarted.done, await stateOf()], [false, ["ids", RECOUNT_VERSION]]);

  part("2. applySums: healthy control and the room read unknown");
  const OWNER = "sweepa2recount@example.com";
  await claimHandle(OWNER, "sweeprecount", "Sweep Recount", "");
  await ensureStatsId(OWNER);
  await ensureStoreId(OWNER);
  const store = (await storeForEmail(OWNER))!;
  const room = dataKey(store)!;
  const setup = async () => {
    await original([["DEL", room]]);
    await noteData(store, [{ slot: "already", bytes: 5_000, set: true }]);
    await original([["HSET", STATE_KEY, "phase", "apply", "cursor", "0", "version", RECOUNT_VERSION], ["HSET", SUM_KEY, OWNER, 8_000]]);
  };
  const legacy = async () => Number((await original([["HGET", room, LEGACY_SLOT]]))[0] ?? 0);
  await setup();
  await recountStep(Date.now() + 5_000);
  const right = await legacy();
  await setup();
  redis.pipeline = (async (commands: (string | number)[][]) => {
    if (commands[0]?.[0] === "HMGET" && commands[0][1] === room) return ["?"];
    return original(commands);
  }) as typeof redis.pipeline;
  await recountStep(Date.now() + 5_000);
  redis.pipeline = original;
  const wrong = await legacy();
  console.log(`  legacy slot: healthy ${right}, unknown read ${wrong}`);
  is("healthy: legacy is only what the room does not already count", right < 8_000, true);
  is("DEFECT: on the unknown read, legacy is the whole 8,000 again, on top of what is counted", [wrong, wrong > right], [8_000, true]);
  done();
}
main();
