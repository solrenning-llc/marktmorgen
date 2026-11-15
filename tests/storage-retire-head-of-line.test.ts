import { test } from "node:test";
import assert from "node:assert/strict";
import { store } from "./redis-stub";
import { reserveStorage, bindStorage, retireStorage } from "@/lib/storage-reservations";

// The same atomic-script stand-in tests/storage-reservations.test.ts uses.
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

const folder = "ab".repeat(16);
const path = (n: number) => `vault/${folder}/product/${n.toString(16).padStart(16, "0")}-file.pdf`;

test("one session the provider cannot confirm retired never holds every other expired session's bytes", async () => {
  // Three abandoned uploads fill the store's room. The first one's session can no longer be confirmed
  // (for example, the provider's own lifecycle rule already removed the incomplete upload: DELETE answers
  // 404 and no object exists, which lib/vault.ts retireVaultSession keeps as unconfirmed). The other two
  // are cancelled by the provider on the first ask.
  const sessions = [];
  for (let n = 1; n <= 3; n += 1) {
    const entry = await reserveStorage(folder, 10, 30, async () => 0);
    await bindStorage(folder, entry.id, path(n), `session-${n}`);
    sessions.push(entry);
  }
  const asked: string[] = [];
  const retire = async (row: { uploadId?: string }) => {
    asked.push(row.uploadId ?? "");
    return row.uploadId !== "session-1";
  };
  // One cleanup per admission attempt (lib/vault-storage.ts openReservedVault): ten attempts.
  const later = Date.now() + 25 * 60 * 60 * 1000;
  for (let attempt = 0; attempt < 10; attempt += 1) await retireStorage(folder, later, retire);
  assert.ok(asked.includes("session-2") && asked.includes("session-3"),
    `the cancellable sessions were never asked about; every attempt asked only: ${[...new Set(asked)].join(", ")}`);
  // The 20 bytes of the two cancelled sessions are room again; only the unconfirmed 10 stay held.
  await reserveStorage(folder, 20, 30, async () => 0);
});
