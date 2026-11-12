import { test } from "node:test";
import assert from "node:assert/strict";
import { store } from "./redis-stub";
import { reserveStorage, bindStorage, retireStorage } from "@/lib/storage-reservations";

// Minimal stand-in for the two lease scripts the ledger runs through EVAL.
const original = store.run.bind(store);
store.run = ((command: (string | number)[]) => {
  if (String(command[0]).toUpperCase() !== "EVAL") return original(command);
  const source = String(command[1]);
  const count = Number(command[2]);
  const keys = command.slice(3, 3 + count);
  const args = command.slice(3 + count);
  if (original(["GET", keys[0]]) !== args[0]) return 0;
  if (source.includes('redis.call("SET", KEYS[2]')) { original(["SET", keys[1], args[1]]); return 1; }
  if (source.includes('redis.call("DEL", KEYS[1])')) return original(["DEL", keys[0]]);
  throw new Error("unexpected script");
}) as typeof store.run;
const folder = "c".repeat(32);
const path = (name: string) => "vault/" + folder + "/product/0123456789abcdef-" + name;

test("an expired session that cannot be retired does not block retiring the next one", async () => {
  const a = await reserveStorage(folder, 5, 10, async () => 0);
  await bindStorage(folder, a.id, path("a"), "session-a");
  const b = await reserveStorage(folder, 5, 10, async () => 0);
  await bindStorage(folder, b.id, path("b"), "session-b");
  const tried: string[] = [];
  const retire = async (row: { uploadId?: string }) => { tried.push(row.uploadId!); return row.uploadId === "session-b"; };
  const later = Date.now() + 1000;
  const first = await retireStorage(folder, later, retire);
  const second = await retireStorage(folder, later, retire);
  assert.equal(first || second, true, "B's retirement must eventually be attempted and succeed");
  assert.ok(tried.includes("session-b"));
  // B's bytes are back; A's stay reserved because its provider never acknowledged retirement.
  await reserveStorage(folder, 5, 10, async () => 0);
  await assert.rejects(reserveStorage(folder, 1, 10, async () => 0), /storage_(limit|pending)/);
});
