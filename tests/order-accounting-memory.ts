/** Journey adapter for the existing atomic settlement script only. It grants
 * no funding and is not Lua proof: the unchanged production script is also
 * exercised by test_order_confirmation_checkpoint_redis.py on real Redis. */
import type { MemoryRedis } from "@/lib/redis-memory";

type Command = (string | number)[];
export function isOrderAccounting(command: Command): boolean {
  return command[0] === "EVAL" && typeof command[1] === "string" &&
    command[1].startsWith("-- marktmorgen:order-confirmation-settlement:v1\n");
}

export function orderAccounting(store: MemoryRedis, command: Command): number {
  if (command[2] !== 6 || command.length !== 18) return -1;
  const keys = command.slice(3, 9).map(String), a = command.slice(9).map(String);
  if (new Set(keys).size !== 6) return -1;
  const expected = ["string", "string", "hash", "hash", "set", "string"];
  const types = keys.map(k => store.run(["TYPE", k]));
  if (types.some((kind, i) => kind !== "none" && kind !== expected[i])) return -1;
  const [receipt, hour, rawBytes, rawN, folder, owner, rawUntil, rawNow, rawKeep] = a;
  const bytes = Number(rawBytes), n = Number(rawN), until = Number(rawUntil), now = Number(rawNow), keep = Number(rawKeep);
  if (receipt.length !== 68 || !receipt.startsWith("oc1:") || !Number.isInteger(bytes) || bytes < 1 || bytes > 1e9 ||
      (n !== 0 && n !== 1) || folder.length !== 32 || owner.length < 1 || owner.length > 320 ||
      !Number.isFinite(until) || !Number.isFinite(now) || until <= now || until <= store.now() || keep !== 34_560_000) return -1;
  const prior = store.run(["GETRANGE", keys[0], 0, 68]);
  if (prior !== "") return prior === receipt ? 2 : -1;
  if (types[0] !== "none") return -1;
  const number = (raw: unknown): number | null => {
    if (raw === null) return 0;
    if (typeof raw !== "string" || !/^(0|[1-9][0-9]*)$/.test(raw) || raw.length > 13) return null;
    const value = Number(raw);
    return Number.isSafeInteger(value) && value <= 1e12 ? value : null;
  };
  const counted = types[1] === "none" ? 0 : number(store.run(["GETRANGE", keys[1], 0, 16]));
  if (counted === null || counted + n > 1e12) return -1;
  if (types[5] !== "none" && store.run(["GETRANGE", keys[5], 0, 320]) !== owner) return -1;
  let held = 0, kept = 0;
  if (hour !== "") {
    if (!/^\d{1,9}$/.test(hour)) return -1;
    const h = number(store.run(["HGET", keys[2], hour])), b = number(store.run(["HGET", keys[3], hour]));
    if (h === null || b === null || (h === 0 && b !== 0) || (h > 0 && b < bytes)) return -1;
    held = h;kept = b;
  }
  // Synchronous from the last validation through the final receipt, matching
  // one native EVAL. MemoryRedis lacks SET PXAT; PEXPIRE preserves its clock.
  const mark = (value: string) => {
    store.run(["SET", keys[0], value]);
    store.run(["PEXPIRE", keys[0], until - store.now()]);
  };
  mark(`oci:${receipt.slice(4)}`);
  if (n === 1) {
    store.run(["INCR", keys[1]]);store.run(["EXPIRE", keys[1], keep]);
    if (counted === 0 || (counted + 1) % 100 === 0) {
      store.run(["SADD", keys[4], folder]);store.run(["EXPIRE", keys[4], keep]);store.run(["SET", keys[5], owner]);
    }
  }
  if (hour !== "" && held > 0) {
    store.run(held === 1 ? ["HDEL", keys[2], hour] : ["HINCRBY", keys[2], hour, -1]);
    store.run(kept === bytes ? ["HDEL", keys[3], hour] : ["HINCRBY", keys[3], hour, -bytes]);
  }
  mark(receipt);
  return 1;
}

/** The stuck legacy checkout's count (lib/orders.ts COUNT_STUCK_LEGACY_CHECKOUT), for the same journeys. Real Redis
 * runs the production script in scripts/test_legacy_order_accounting_redis.py. */
export function isStuckAccounting(command: Command): boolean {
  return command[0] === "EVAL" && typeof command[1] === "string" &&
    command[1].startsWith("-- marktmorgen:legacy-checkout-stuck:v1\n");
}

export function stuckAccounting(store: MemoryRedis, command: Command): number {
  if (command[2] !== 4 || command.length !== 13) return -1;
  const keys = command.slice(3, 7).map(String), [mark, folder, owner, rawUntil, rawNow, rawKeep] = command.slice(7).map(String);
  if (new Set(keys).size !== 4) return -1;
  const until = Number(rawUntil), now = Number(rawNow), keep = Number(rawKeep);
  if (mark.length !== 68 || !mark.startsWith("ocf:") || folder.length !== 32 || owner.length < 1 || owner.length > 320 ||
      !Number.isFinite(until) || !Number.isFinite(now) || until <= now || keep !== 34_560_000) return -1;
  const [seenKind, counterKind, foldersKind, ownerKind] = keys.map(k => store.run(["TYPE", k]));
  if (until <= store.now()) return -1;
  if (seenKind === "string") {
    const prior = String(store.run(["GETRANGE", keys[0], 0, 3]));
    if (prior === "oc1:" || prior === "ocf:") return 2;
  }
  if (counterKind !== "none" && counterKind !== "string") return -1;
  if (counterKind === "string") {
    const raw = store.run(["GETRANGE", keys[1], 0, 16]);
    if (typeof raw !== "string" || !/^\d+$/.test(raw) || raw.length > 13 || String(Number(raw)) !== raw || Number(raw) + 1 > 1e12) return -1;
  }
  store.run(["INCR", keys[1]]);store.run(["EXPIRE", keys[1], keep]);
  if (foldersKind === "none" || foldersKind === "set") { store.run(["SADD", keys[2], folder]);store.run(["EXPIRE", keys[2], keep]); }
  if (ownerKind === "none") store.run(["SET", keys[3], owner]);
  // MemoryRedis lacks SET PXAT; SET replaces a key of any type, as native SET does, and PEXPIRE keeps its clock.
  store.run(["DEL", keys[0]]);store.run(["SET", keys[0], mark]);store.run(["PEXPIRE", keys[0], until - store.now()]);
  return 1;
}
