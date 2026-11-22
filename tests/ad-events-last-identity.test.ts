/**
 * The ad platforms' last answers (lib/ad-events.ts KEEP_LAST_IF_LIVE) as lib/redis-memory.ts models it: kept only for
 * the same live store (Codex L-20261120-1242), each reply, the exact count of the script's inner commands, and nothing
 * written on a refusal. tests/ad-events-erasure.test.ts drives the real sendServerLead through it.
 */
import { KEEP_LAST_IF_LIVE } from "@/lib/ad-events";
import { MemoryRedis } from "@/lib/redis-memory";
import { ERASING_KEY, MAX_STORE_BYTES, erasingField, ownerKey, storeIdCommand, storeRef, type Store } from "@/lib/store";
import { done, is, part } from "./check";

async function main(): Promise<void> {
  part("Kept only for the same live store; refusals write nothing and count only the calls made");
  const redis = new MemoryRedis();
  const store = { sid: "a".repeat(32), email: "diagnostics@example.com", extra: false, statsId: "b".repeat(32) } as Store;
  const field = await erasingField(storeRef(store));
  const id = storeIdCommand(store.sid)[1];
  const owner = await ownerKey(storeRef(store));
  const last = `nl:adsrv:last:${store.statsId}`;
  const json = JSON.stringify({ at: 1234567890, kind: "lead", meta: "Refused: diagnostics@example.com" });
  const cases = [
    { name: "id gone", mode: "id", raw: null, marked: false, answer: 0, calls: 1 },
    { name: "id erasing", mode: "id", raw: "owner-ref", marked: true, answer: 0, calls: 2 },
    { name: "id live", mode: "id", raw: "owner-ref", marked: false, answer: 1, calls: 3 },
    { name: "legacy gone", mode: "legacy", raw: null, marked: false, answer: 0, calls: 1 },
    { name: "legacy replaced by another store", mode: "legacy", raw: JSON.stringify({ statsId: "c".repeat(32) }), marked: false, answer: 0, calls: 1 },
    { name: "legacy erasing", mode: "legacy", raw: JSON.stringify({ statsId: store.statsId }), marked: true, answer: 0, calls: 2 },
    { name: "legacy live, an id given since", mode: "legacy", raw: JSON.stringify({ sid: store.sid, statsId: store.statsId }), marked: false, answer: 1, calls: 3 },
    { name: "legacy record larger than any record", mode: "legacy", raw: " ".repeat(MAX_STORE_BYTES + 1), marked: false, answer: -1, calls: 1 },
    ...["broken", "null", "[]", "123", "{}", '{"statsId":null}', '{"statsId":""}'].map((raw) => ({ name: `legacy unreadable ${raw}`, mode: "legacy", raw, marked: false, answer: -1, calls: 1 })),
    { name: "unknown mode", mode: "other", raw: "owner-ref", marked: false, answer: -1, calls: 0 },
  ];
  for (const row of cases) {
    redis.clear();
    const live = row.mode === "id" ? id : owner;
    if (row.raw !== null) redis.run(["SET", live, row.raw]);
    if (row.marked) redis.run(["HSET", ERASING_KEY, field, "1"]);
    const before = redis.scriptCalls;
    is(`${row.name}: reply`, redis.run(["EVAL", KEEP_LAST_IF_LIVE, 3, live, ERASING_KEY, last, field, json, 90 * 86400, row.mode, store.statsId as string, MAX_STORE_BYTES]), row.answer);
    is(`${row.name}: inner calls`, redis.scriptCalls - before, row.calls);
    is(`${row.name}: answers kept`, redis.run(["GET", last]), row.answer === 1 ? json : null);
    if (row.answer === 1) is(`${row.name}: for ninety days`, redis.run(["TTL", last]), 90 * 86400);
  }
  part("A legacy store with no statsId is never read as live");
  redis.clear();
  redis.run(["SET", owner, JSON.stringify({ statsId: "" })]);
  is("empty statsId argument: unknown, nothing kept", [redis.run(["EVAL", KEEP_LAST_IF_LIVE, 3, owner, ERASING_KEY, last, field, json, 90 * 86400, "legacy", "", MAX_STORE_BYTES]), redis.run(["GET", last])], [-1, null]);
  done();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
