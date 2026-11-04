/**
 * 273 [BK1]: the export of every key of ours in the database, for the daily
 * backup, and its restore into an empty database. Built and tested; nothing
 * calls it yet (no schedule, bucket, credential or key exists: those are the
 * owner's steps in docs/backup.md), so it is off.
 *
 * The export walks the keys with SCAN, keeps those under BACKUP_PREFIX, and
 * copies each with DUMP (Redis's own serialized value, every type, read with
 * the REST API's base64 answers so its bytes are not lost) and PEXPIRETIME
 * (the moment it ends, as the server has it). What it costs is counted as it
 * goes: each SCAN is checked against the budget before it is sent, and the
 * whole copy (two commands a key) before any DUMP is. SCAN with MATCH walks
 * the whole database, other products' keys too, so its pages grow with every
 * key there, not only ours. The copy's size is held to `maxBytes` (at most
 * what the backup format seals) batch by batch, and no batch is sent once it
 * is reached. A cap reached is a refusal of the whole: never a partial copy
 * handed back as if it were the whole database. Upstash bills every command
 * (https://upstash.com/docs/redis/overall/billing, read 31 October 2026).
 *
 * Not a point-in-time copy: a key written while the walk runs may be in it
 * with its newer value, and one made after its part of the walk is not; a
 * key's value and its end are read in one request but not as one step. A key
 * gone between the walk and its DUMP is left out, never copied empty.
 *
 * The restore writes into a database that has none of the keys: it looks
 * first and refuses before writing anything when one is there; a key made
 * after that look is refused by the server itself (RESTORE without REPLACE),
 * which stops the restore there.
 */
import { redisPipeline, redisPipelineBase64 } from "@/lib/redis";
import { restoreRows, type BackupRow, type BackupSnapshot } from "@/lib/backup-codec";

/** Every key of ours starts with it (lib/data-families.ts). */
export const BACKUP_PREFIX = "nl:";
/** The most rows the backup format holds (lib/backup-codec.ts). */
export const BACKUP_MAX_ROWS = 10_000;
/** The most the backup format seals, as JSON (lib/backup-codec.ts, MAX). */
export const BACKUP_MAX_BYTES = 4 * 1024 * 1024;
/** Keys a SCAN is asked for at a time; a hint, which the server may answer with more or fewer. */
const SCAN_COUNT = 500;
/** What one row adds to the sealed JSON besides its key and its value: the field names, quotes and its end. */
const ROW_OVERHEAD = 64;
const BASE64 = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;

export type ExportLimits = {
  /** The most keys to copy; more is a refusal. */
  maxRows: number;
  /** The most commands to send in all; a walk or a copy that would need more is a refusal before it is sent. */
  maxCommands: number;
  /** Keys copied per request. */
  batch: number;
  /** The most the copy may weigh, as the backup format seals it; more is a refusal, and no batch is sent after it. */
  maxBytes: number;
  /** The moment of the copy, in ms. */
  now: number;
};

export type ExportResult =
  | { ok: true; snapshot: BackupSnapshot; commands: number; scans: number }
  | { ok: false; reason: "limits" | "budget" | "too_many" | "too_big" | "unreadable"; commands: number };

const whole = (n: unknown, most = Number.MAX_SAFE_INTEGER) => typeof n === "number" && Number.isSafeInteger(n) && n > 0 && n <= most;

/** Every key of ours, copied, or a refusal that says why. */
export async function exportSnapshot(limits: ExportLimits): Promise<ExportResult> {
  const { maxRows, maxCommands, batch, maxBytes, now } = limits;
  if (!whole(maxRows, BACKUP_MAX_ROWS) || !whole(maxCommands) || !whole(batch, 500) || !whole(maxBytes, BACKUP_MAX_BYTES) || !whole(now)) return { ok: false, reason: "limits", commands: 0 };
  let commands = 0;
  let scans = 0;
  const keys = new Set<string>();
  let cursor = "0";
  do {
    if (commands + 1 > maxCommands) return { ok: false, reason: "budget", commands };
    const [reply] = await redisPipeline([["SCAN", cursor, "MATCH", `${BACKUP_PREFIX}*`, "COUNT", SCAN_COUNT]]);
    commands += 1;
    scans += 1;
    if (!Array.isArray(reply) || reply.length !== 2 || typeof reply[0] !== "string" || !Array.isArray(reply[1])) return { ok: false, reason: "unreadable", commands };
    for (const key of reply[1]) {
      // A name that came back with a replacement character is not the key's own name (the JSON answer replaces
      // bytes that are not UTF-8): never copied as gone, the whole is refused.
      if (typeof key !== "string" || key.includes("\uFFFD")) return { ok: false, reason: "unreadable", commands };
      if (key.startsWith(BACKUP_PREFIX)) keys.add(key);
      if (keys.size > maxRows) return { ok: false, reason: "too_many", commands };
    }
    // The same cursor twice running is a walk that does not move: refused, not walked until the budget is spent.
    if (reply[0] !== "0" && reply[0] === cursor) return { ok: false, reason: "unreadable", commands };
    cursor = reply[0];
  } while (cursor !== "0");

  const sorted = [...keys].sort();
  // Decided before any DUMP: the whole copy fits the budget, or nothing is copied.
  if (commands + 2 * sorted.length > maxCommands) return { ok: false, reason: "budget", commands };
  const rows: BackupRow[] = [];
  let bytes = 0;
  for (let at = 0; at < sorted.length; at += batch) {
    const part = sorted.slice(at, at + batch);
    const replies = await redisPipelineBase64(part.flatMap((key) => [["DUMP", key], ["PEXPIRETIME", key]]));
    commands += 2 * part.length;
    if (replies.length !== 2 * part.length) return { ok: false, reason: "unreadable", commands };
    for (let i = 0; i < part.length; i += 1) {
      const dump = replies[2 * i];
      const ends = Number(replies[2 * i + 1]);
      // Gone between the walk and its copy, or ended by the time of the copy: left out, never copied empty.
      if (dump === null || ends === -2 || (ends !== -1 && ends <= now)) continue;
      if (typeof dump !== "string" || !dump || !BASE64.test(dump) || !Number.isSafeInteger(ends) || ends < -1) return { ok: false, reason: "unreadable", commands };
      bytes += part[i].length + dump.length + ROW_OVERHEAD;
      if (bytes > maxBytes) return { ok: false, reason: "too_big", commands };
      rows.push({ key: part[i], dump, expiresAt: ends === -1 ? null : ends });
    }
  }
  return { ok: true, snapshot: { version: 1, capturedAt: now, rows }, commands, scans };
}

/**
 * Where a restore writes: whether keys are there, and one key restored from its DUMP with its end, if any. `restore`
 * must never replace a key (RESTORE without REPLACE, which the server refuses for a key that is there, BUSYKEY):
 * that, and not the check before, is what keeps a key made in between from being written over.
 */
export type RestoreTarget = {
  exists: (keys: string[]) => Promise<number[]>;
  /** true when written; "skipped" for a key whose end passed while the restore ran (nothing written); false on any failure. */
  restore: (key: string, expiresAt: number | null, dump: string) => Promise<boolean | "skipped">;
};

export type RestoreResult = { ok: true; keys: number; skipped?: number } | { ok: false; reason: "exists" | "failed"; keys: number };

/**
 * A snapshot written into an empty database: every row still alive at `now` (lib/backup-codec.ts, restoreRows),
 * each with its own end. Refused before writing anything when the target has any of the keys (`keys`: how many).
 * A write that fails stops it (`keys`: how many were written before it); a target that cannot say which keys are
 * there is a failure; a key whose end passed meanwhile is counted apart (`skipped`), never as written.
 */
export async function restoreSnapshot(snapshot: BackupSnapshot, target: RestoreTarget, now: number): Promise<RestoreResult> {
  const rows = restoreRows(snapshot, now);
  if (rows.length === 0) return { ok: true, keys: 0 };
  let there: number[];
  try {
    there = await target.exists(rows.map((row) => row.key));
  } catch {
    return { ok: false, reason: "failed", keys: 0 };
  }
  if (there.length !== rows.length) return { ok: false, reason: "failed", keys: 0 };
  const taken = there.filter((n) => n > 0).length;
  if (taken > 0) return { ok: false, reason: "exists", keys: taken };
  let written = 0;
  let skipped = 0;
  for (const row of rows) {
    const done = await target.restore(row.key, row.expiresAt, row.dump);
    if (done === "skipped") skipped += 1;
    else if (!done) return { ok: false, reason: "failed", keys: written };
    else written += 1;
  }
  return skipped ? { ok: true, keys: written, skipped } : { ok: true, keys: written };
}
