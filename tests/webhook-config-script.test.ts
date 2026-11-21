/**
 * The webhook settings' fenced compare-and-set (lib/webhooks.ts SAVE_WEBHOOK_CONFIG) as lib/redis-memory.ts models it:
 * each reply, the exact count of the script's inner commands, and nothing written on a refusal.
 * tests/webhook-settings-after-erasure.test.ts drives the real writers through it.
 */
import { MemoryRedis } from "@/lib/redis-memory";
import { ERASING_KEY, MAX_STORE_BYTES, claimHandle, ensureStatsId, erasingField, ownerKey, storeForEmail, storeIdCommand, storeRef } from "@/lib/store";
import { SAVE_WEBHOOK_CONFIG } from "@/lib/webhooks";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";
const OWNER = "config-script@example.com";
const STORES = "nl:hooks:stores";
async function main(): Promise<void> {
  redis.clear();
  await claimHandle(OWNER, "script-hooks", "Script Hooks", "");
  await ensureStatsId(OWNER);
  part("The proposed script counts actual calls and writes nothing on identity/CAS refusals");
  {
    const store = (await storeForEmail(OWNER))!;
    const stats = store.statsId!;
    const field = await erasingField(storeRef(store));
    const id = storeIdCommand(store.sid)[1];
    const owner = await ownerKey(storeRef(store));
    const memory = new MemoryRedis();
    const target = `nl:hooks:cfg:${stats}`;
    const json = JSON.stringify({ handle: store.handle, endpoints: [], since: 0 });
    const rows = [
      { name: "gone id", mode: "id", raw: null, mark: false, was: "", actual: "", action: "", reset: "0", reply: -2, calls: 1 },
      { name: "erasing id", mode: "id", raw: "ref", mark: true, was: "", actual: "", action: "", reset: "0", reply: -2, calls: 2 },
      { name: "CAS changed", mode: "id", raw: "ref", mark: false, was: "before", actual: "other", action: "", reset: "0", reply: [-1], calls: 3 },
      { name: "ordinary edit", mode: "id", raw: "ref", mark: false, was: "", actual: "", action: "", reset: "0", reply: 1, calls: 4 },
      { name: "first add", mode: "id", raw: "ref", mark: false, was: "", actual: "", action: "add", reset: "1", reply: 1, calls: 7 },
      { name: "last remove", mode: "id", raw: "ref", mark: false, was: "", actual: "", action: "remove", reset: "0", reply: 1, calls: 6 },
      { name: "legacy replacement", mode: "legacy", raw: JSON.stringify({ statsId: "other" }), mark: false, was: "", actual: "", action: "add", reset: "1", reply: -2, calls: 1 },
      { name: "legacy unreadable", mode: "legacy", raw: "{broken", mark: false, was: "", actual: "", action: "add", reset: "1", reply: -3, calls: 1 },
      { name: "legacy oversized", mode: "legacy", raw: " ".repeat(MAX_STORE_BYTES + 1), mark: false, was: "", actual: "", action: "add", reset: "1", reply: -3, calls: 1 },
      { name: "watch type unreadable", mode: "id", raw: "ref", mark: false, was: "", actual: "", action: "add", reset: "1", reply: -3, calls: 4, watchRaw: "broken" },
      { name: "same legacy", mode: "legacy", raw: JSON.stringify({ statsId: stats, sid: store.sid }), mark: false, was: "", actual: "", action: "add", reset: "1", reply: 1, calls: 7 },
    ];
    for (const row of rows) {
      memory.clear();
      const live = row.mode === "id" ? id : owner;
      if (row.raw !== null) memory.run(["SET", live, row.raw]);
      if (row.mark) memory.run(["HSET", ERASING_KEY, field, "1"]);
      if (row.actual) memory.run(["SET", target, row.actual]);
      if ("watchRaw" in row && typeof row.watchRaw === "string") memory.run(["SET", STORES, row.watchRaw]);
      const before = memory.scriptCalls;
      const answer = memory.run(["EVAL", SAVE_WEBHOOK_CONFIG, 7, target, live, ERASING_KEY, STORES,
        `nl:hooks:anchor:${stats}`, `nl:hooks:anchor:${stats}:back`, `nl:hooks:wait:${stats}`,
        row.was, json, field, stats, row.mode, row.action, row.reset, MAX_STORE_BYTES]);
      is(row.name + ": reply", answer, row.reply);
      is(row.name + ": exact inner command count", memory.scriptCalls - before, row.calls);
      is(row.name + ": retained config", memory.run(["GET", target]), row.reply === 1 ? json : row.actual || null);
    }
  }
  done();
}
main().catch((error) => { console.error(error); process.exit(1); });
