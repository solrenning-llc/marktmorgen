import { readVaultPath } from "@/lib/vault-rules";
import { redisPipeline } from "@/lib/redis";
import { takeLock, type Held } from "@/lib/redis-lock";

export type StorageReservation = { id: string; bytes: number; at: number; pathname?: string; uploadId?: string };
const key = (folder: string) => {
  if (!/^[a-f0-9]{32}$/.test(folder)) throw new Error("storage_folder");
  return "nl:storage:pending:" + folder;
};
// The same two atomic steps as lib/redis-lock.ts's release and fenced set, under their names, so the repository's
// in-memory Redis (lib/redis-memory.ts) runs them as Upstash does for every caller's tests.
const RELEASE = '-- marktmorgen:release:v1\nif redis.call("GET", KEYS[1]) == ARGV[1] then return redis.call("DEL", KEYS[1]) else return 0 end';
const WRITE = '-- marktmorgen:fenced-set:v1\nif redis.call("GET", KEYS[1]) == ARGV[1] then redis.call("SET", KEYS[2], ARGV[2]) return 1 else return 0 end';

function decode(raw: unknown): StorageReservation[] {
  if (raw === null) return [];
  let rows: unknown;
  try { if (typeof raw !== "string") throw new Error(); rows = JSON.parse(raw); }
  catch { throw new Error("storage_unknown"); }
  if (!Array.isArray(rows) || rows.length > 64) throw new Error("storage_unknown");
  const ids = new Set<string>();
  for (const row of rows) {
    if (!row || !/^[a-f0-9]{32}$/.test(row.id) || ids.has(row.id) ||
      !Number.isSafeInteger(row.bytes) || row.bytes <= 0 ||
      !Number.isSafeInteger(row.at) || row.at < 0 ||
      (row.pathname !== undefined && (typeof row.pathname !== "string" || !row.pathname)) ||
      (row.uploadId !== undefined && (typeof row.uploadId !== "string" || !row.uploadId)) ||
      ((row.pathname === undefined) !== (row.uploadId === undefined))) throw new Error("storage_unknown");
    ids.add(row.id);
  }
  return rows;
}

async function change<T>(folder: string, work: (rows: StorageReservation[]) => Promise<T>): Promise<T> {
  const record = key(folder);
  const held: Held = await takeLock(record + ":lock", 120, 5000);
  try {
    const [raw] = await redisPipeline([["GET", record]]);
    const rows = decode(raw);
    if (rows.some(row => row.pathname !== undefined && readVaultPath(row.pathname)?.folder !== folder)) throw new Error("storage_unknown");
    const result = await work(rows);
    // No GET/SET fallback: a lost lease must never overwrite another admission.
    const [written] = await redisPipeline([["EVAL", WRITE, 2, held.key, record, held.token, JSON.stringify(rows)]]);
    if (written !== 1) throw new Error("storage_lease_lost");
    return result;
  } finally {
    await redisPipeline([["EVAL", RELEASE, 1, held.key, held.token]]).catch(() => undefined);
  }
}

/** Measures complete objects while holding the same lease used for pending uploads.
 * Pending bytes never expire automatically: the provider must first acknowledge retirement.
 */
export async function reserveStorage(folder: string, bytes: number, limit: number, measure: () => Promise<number>): Promise<StorageReservation> {
  if (!Number.isSafeInteger(bytes) || bytes <= 0 || !Number.isSafeInteger(limit) || limit < 0) throw new Error("storage_invalid");
  return change(folder, async rows => {
    if (rows.length >= 64) throw new Error("storage_busy");
    const used = await measure();
    if (!Number.isSafeInteger(used) || used < 0) throw new Error("storage_unknown");
    let total = used;
    for (const row of rows) {
      total += row.bytes;
      if (!Number.isSafeInteger(total)) throw new Error("storage_unknown");
    }
    if (bytes > limit - total) throw new Error(bytes <= limit - used ? "storage_pending" : "storage_limit");
    const entry = { id: crypto.randomUUID().replaceAll("-", ""), bytes, at: Date.now() };
    rows.push(entry);
    return entry;
  });
}

export async function bindStorage(folder: string, id: string, pathname: string, uploadId: string): Promise<void> {
  if (readVaultPath(pathname)?.folder !== folder || !uploadId) throw new Error("storage_invalid");
  await change(folder, async rows => {
    const row = rows.find(row => row.id === id);
    if (!row || row.pathname !== undefined) throw new Error("storage_reservation_missing");
    row.pathname = pathname;
    row.uploadId = uploadId;
  });
}

/** Call only after completion or confirmed provider cancellation. */
export async function releaseStorage(folder: string, id: string): Promise<void> {
  await change(folder, async rows => {
    const index = rows.findIndex(row => row.id === id);
    if (index >= 0) rows.splice(index, 1);
  });
}

/** Retires at most one expired session. Failure retains every reserved byte. */
export async function retireStorage(folder: string, before: number, retire: (entry: Readonly<StorageReservation>) => Promise<boolean>): Promise<boolean> {
  if (!Number.isSafeInteger(before) || before < 0) throw new Error("storage_invalid");
  return change(folder, async rows => {
    const index = rows.findIndex(row => row.at <= before);
    if (index < 0) return false;
    const entry = rows[index];
    if (entry.pathname !== undefined && !(await retire(Object.freeze({ ...entry })))) return false;
    rows.splice(index, 1);
    return true;
  });
}
