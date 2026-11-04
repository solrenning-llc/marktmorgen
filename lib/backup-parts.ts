/**
 * A backup in parts (273 [BK1]; inbox C4-30): the database copied as a set of
 * sealed parts of at most PART_MAX_BYTES each, plus a sealed manifest that
 * names every part with its rows, its size and the SHA-256 of what was
 * stored. One store at full use can keep far more than one sealed object
 * holds (docs/backup-cost-2026-11-04.md), so a single object refused them all.
 *
 * - Every part is sealed (lib/backup-codec.ts), written create-only and read
 *   back before the next one is copied; the manifest is written last and read
 *   back too. The set counts as verified only when the manifest read back
 *   names every part with the sums of what was stored.
 * - Nothing is ever deleted or replaced: a run that fails leaves the parts it
 *   wrote as unreferenced objects (no manifest names them) and every earlier
 *   verified set as it was. The bucket's lifecycle rule removes them all.
 * - The walk's and the copy's commands are counted against the run's cap
 *   before the first DUMP; the parts and the bytes are counted as the copy
 *   goes, each row at the bytes it adds to its part's JSON: a database larger
 *   than the run may copy is refused, never written as a whole set.
 *
 * Server-only. Built and off: nothing schedules it (lib/backup-run.ts).
 */
import { createCipheriv, createDecipheriv, createHash, randomBytes, randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { gunzipSync, gzipSync } from "node:zlib";
import { openBackup, sealBackup, type BackupRow, type BackupSnapshot } from "@/lib/backup-codec";
import { BACKUP_MAX_BYTES, BACKUP_MAX_ROWS, BACKUP_PREFIX } from "@/lib/backup-export";
import type { BackupObjectStore } from "@/lib/backup-roundtrip";
import { redisPipeline, redisPipelineBase64 } from "@/lib/redis";

/** The most one part holds, as the backup format seals it (JSON), and its rows. */
export const PART_MAX_BYTES = BACKUP_MAX_BYTES;
export const PART_MAX_ROWS = BACKUP_MAX_ROWS;
/** What one stored part may weigh beyond its JSON: the sealed header and the compressor's worst growth. */
export const PART_SEAL_ROOM = 65_536;
/** What one part's entry adds to the manifest, at the most (its id, counts and sum, as JSON). */
const MANIFEST_ENTRY_BYTES = 160;
/** The manifest's own envelope and header room. */
const MANIFEST_ROOM = 65_536;
/** The most parts one set may have: its manifest stays a small object. */
export const MAX_PARTS = 10_000;
/** Keys a SCAN is asked for at a time; a hint. */
const SCAN_COUNT = 500;
/** The longest key the backup format keeps (lib/backup-codec.ts), in bytes. */
const KEY_MAX_BYTES = 1_024;
const BASE64 = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;
const MANIFEST_MAGIC = Buffer.from("MMBM1");
const MANIFEST_AAD = Buffer.from("marktmorgen/backup-manifest/v1");

/** The caps of one run in parts, decided by the reviewed cost ceiling (lib/backup-run.ts). */
export type PartsLimits = {
  /** The most keys the run copies, every part together. */
  maxRows: number;
  /** The most database commands the run sends for the walk and the copy. */
  maxCommands: number;
  /** The most parts. */
  maxParts: number;
  /** The most the copy may weigh as sealed JSON, every part together. */
  maxRunBytes: number;
  /** Keys copied per request. */
  batch: number;
  /** The moment of the copy, in ms. */
  now: number;
  /** The most one part holds as sealed JSON: PART_MAX_BYTES, or less (the tests make several parts of a small set). */
  partBytes?: number;
};

export type PartEntry = { id: string; rows: number; bytes: number; sha256: string };
export type BackupManifest = { version: 1; capturedAt: number; parts: PartEntry[]; rows: number };

export type PartsResult =
  | { ok: true; id: string; keys: number; bytes: number; parts: number; commands: number }
  | { ok: false; reason: "limits" | "budget" | "too_many" | "too_big" | "too_many_parts" | "unreadable" | "error" | "verify"; commands: number; parts: number };

const whole = (n: unknown, most = Number.MAX_SAFE_INTEGER) => typeof n === "number" && Number.isSafeInteger(n) && n > 0 && n <= most;
const sha256 = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");

/** The most a stored manifest of `parts` entries may weigh. */
export const manifestBound = (parts: number) => parts * MANIFEST_ENTRY_BYTES + MANIFEST_ROOM;
/** The most one run's stored objects may weigh: every part sealed, and the manifest. */
export const runStoredBound = (limits: Pick<PartsLimits, "maxParts" | "maxRunBytes">) => limits.maxRunBytes + limits.maxParts * PART_SEAL_ROOM + manifestBound(limits.maxParts);

function validManifest(raw: unknown): BackupManifest {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error("Invalid manifest");
  const m = raw as Partial<BackupManifest>;
  if (m.version !== 1 || !Number.isSafeInteger(m.capturedAt) || Number(m.capturedAt) < 0 || !Array.isArray(m.parts) || m.parts.length > MAX_PARTS || !Number.isSafeInteger(m.rows)) {
    throw new Error("Invalid manifest");
  }
  const ids = new Set<string>();
  let rows = 0;
  for (const part of m.parts) {
    if (!part || typeof part !== "object" || typeof part.id !== "string" || !/^[0-9a-f-]{36}$/.test(part.id) || ids.has(part.id) ||
        !Number.isSafeInteger(part.rows) || part.rows < 0 || part.rows > PART_MAX_ROWS ||
        !Number.isSafeInteger(part.bytes) || part.bytes < 34 || part.bytes > PART_MAX_BYTES + PART_SEAL_ROOM ||
        typeof part.sha256 !== "string" || !/^[0-9a-f]{64}$/.test(part.sha256)) throw new Error("Invalid manifest part");
    ids.add(part.id);
    rows += part.rows;
  }
  if (rows !== m.rows) throw new Error("Invalid manifest rows");
  return m as BackupManifest;
}

/** The manifest, sealed as the parts are (AES-256-GCM over gzip), under its own magic and associated data. */
export function sealManifest(manifest: BackupManifest, key: Uint8Array): Buffer {
  if (key.byteLength !== 32) throw new Error("Invalid backup key");
  const plain = Buffer.from(JSON.stringify(validManifest(manifest)));
  if (plain.length > manifestBound(manifest.parts.length)) throw new Error("Manifest exceeds its bound");
  const nonce = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, nonce);
  cipher.setAAD(MANIFEST_AAD);
  const encrypted = Buffer.concat([cipher.update(gzipSync(plain)), cipher.final()]);
  return Buffer.concat([MANIFEST_MAGIC, nonce, cipher.getAuthTag(), encrypted]);
}

export function openManifest(sealed: Uint8Array, key: Uint8Array): BackupManifest {
  if (key.byteLength !== 32) throw new Error("Invalid backup key");
  const blob = Buffer.from(sealed);
  if (blob.length < 34 || blob.length > manifestBound(MAX_PARTS) || !blob.subarray(0, 5).equals(MANIFEST_MAGIC)) throw new Error("Invalid manifest envelope");
  const decipher = createDecipheriv("aes-256-gcm", key, blob.subarray(5, 17));
  decipher.setAAD(MANIFEST_AAD);
  decipher.setAuthTag(blob.subarray(17, 33));
  // Authenticated before it is unpacked or read.
  const packed = Buffer.concat([decipher.update(blob.subarray(33)), decipher.final()]);
  return validManifest(JSON.parse(gunzipSync(packed, { maxOutputLength: manifestBound(MAX_PARTS) }).toString("utf8")));
}

/** One part sealed, written create-only and read back the same; its entry for the manifest. */
async function putPart(snapshot: BackupSnapshot, key: Uint8Array, store: BackupObjectStore): Promise<PartEntry> {
  const sealed = sealBackup(snapshot, key);
  if (sealed.length > PART_MAX_BYTES + PART_SEAL_ROOM) throw new Error("Part exceeds its bound");
  const id = randomUUID();
  await store.putNew(id, sealed);
  const read = await store.read(id, PART_MAX_BYTES + PART_SEAL_ROOM);
  if (read.byteLength !== sealed.length || sha256(read) !== sha256(sealed)) throw new Error("Part read-back differs");
  if (!isDeepStrictEqual(openBackup(read, key), snapshot)) throw new Error("Part read-back mismatch");
  return { id, rows: snapshot.rows.length, bytes: read.byteLength, sha256: sha256(read) };
}

/**
 * Every key of ours, copied as a set of verified parts and a verified
 * manifest; or a refusal that says why, with how many commands were sent and
 * parts written. Never throws.
 */
export async function copyInParts(limits: PartsLimits, key: Uint8Array, store: BackupObjectStore): Promise<PartsResult> {
  const { maxRows, maxCommands, maxParts, maxRunBytes, batch, now, partBytes = PART_MAX_BYTES } = limits;
  if (!whole(maxRows) || !whole(maxCommands) || !whole(maxParts, MAX_PARTS) || !whole(maxRunBytes) || !whole(batch, 500) || !whole(now) || !whole(partBytes, PART_MAX_BYTES) || partBytes <= 1_024 || key.byteLength !== 32) {
    return { ok: false, reason: "limits", commands: 0, parts: 0 };
  }
  let commands = 0;
  const entries: PartEntry[] = [];
  const fail = (reason: Exclude<PartsResult, { ok: true }>["reason"]): PartsResult => ({ ok: false, reason, commands, parts: entries.length });
  // Which side a throw came from: the database while reading ("error"), or a part or the manifest being sealed,
  // written or read back ("verify").
  let writing = false;
  try {
    // The walk: every name of ours, each SCAN counted before it is sent.
    const keys = new Set<string>();
    let cursor = "0";
    do {
      if (commands + 1 > maxCommands) return fail("budget");
      const [reply] = await redisPipeline([["SCAN", cursor, "MATCH", `${BACKUP_PREFIX}*`, "COUNT", SCAN_COUNT]]);
      commands += 1;
      if (!Array.isArray(reply) || reply.length !== 2 || typeof reply[0] !== "string" || !Array.isArray(reply[1])) return fail("unreadable");
      for (const name of reply[1]) {
        if (typeof name !== "string" || name.includes("�")) return fail("unreadable");
        // A key the format cannot keep: refused before anything is copied, never found out by a failed seal.
        if (Buffer.byteLength(name, "utf8") > KEY_MAX_BYTES) return fail("too_big");
        if (name.startsWith(BACKUP_PREFIX)) keys.add(name);
        if (keys.size > maxRows) return fail("too_many");
      }
      if (reply[0] !== "0" && reply[0] === cursor) return fail("unreadable");
      cursor = reply[0];
    } while (cursor !== "0");

    const sorted = [...keys].sort();
    // Decided before any DUMP: the whole copy fits the run's commands, or nothing is copied.
    if (commands + 2 * sorted.length > maxCommands) return fail("budget");

    let rows: BackupRow[] = [];
    let filled = 0;
    let runBytes = 0;
    let copied = 0;
    const close = async () => {
      if (rows.length === 0) return;
      if (entries.length + 1 > maxParts) throw new RangeError("too_many_parts");
      writing = true;
      entries.push(await putPart({ version: 1, capturedAt: now, rows }, key, store));
      writing = false;
      copied += rows.length;
      rows = [];
      filled = 0;
    };
    for (let at = 0; at < sorted.length; at += batch) {
      const names = sorted.slice(at, at + batch);
      const replies = await redisPipelineBase64(names.flatMap((name) => [["DUMP", name], ["PEXPIRETIME", name]]));
      commands += 2 * names.length;
      if (replies.length !== 2 * names.length) return fail("unreadable");
      for (let i = 0; i < names.length; i += 1) {
        const dump = replies[2 * i];
        const ends = Number(replies[2 * i + 1]);
        // Gone between the walk and its copy, or ended by the time of the copy: left out, never copied empty.
        if (dump === null || ends === -2 || (ends !== -1 && ends <= now)) continue;
        if (typeof dump !== "string" || !dump || !BASE64.test(dump) || Buffer.from(dump, "base64").toString("base64") !== dump || !Number.isSafeInteger(ends) || ends < -1) return fail("unreadable");
        const row: BackupRow = { key: names[i], dump, expiresAt: ends === -1 ? null : ends };
        // The bytes it adds to its part's JSON, escapes and UTF-8 included, and its comma.
        const size = Buffer.byteLength(JSON.stringify(row), "utf8") + 1;
        // One key larger than a part holds cannot be split: refused whole.
        if (size > partBytes - 1_024) return fail("too_big");
        if (runBytes + size > maxRunBytes) return fail("too_big");
        if (filled + size > partBytes - 1_024 || rows.length + 1 > PART_MAX_ROWS) await close();
        rows.push(row);
        filled += size;
        runBytes += size;
      }
    }
    await close();

    // The manifest last: the set is one only when it is read back naming every part and its sums.
    writing = true;
    const manifest: BackupManifest = { version: 1, capturedAt: now, parts: entries, rows: copied };
    const sealed = sealManifest(manifest, key);
    const id = randomUUID();
    await store.putNew(id, sealed);
    const read = await store.read(id, manifestBound(entries.length));
    if (!isDeepStrictEqual(openManifest(read, key), manifest)) return fail("verify");
    const bytes = entries.reduce((n, part) => n + part.bytes, 0) + read.byteLength;
    return { ok: true, id, keys: copied, bytes, parts: entries.length, commands };
  } catch (error) {
    if (error instanceof RangeError && error.message === "too_many_parts") return fail("too_many_parts");
    // The database failing while it was read: said as such, nothing referenced written.
    if (!writing) return fail("error");
    // A seal, a write or a read-back failed: what was written stays unreferenced; every earlier set as it was.
    return fail("verify");
  }
}

/**
 * A verified set read back for a restore, one part at a time: the manifest
 * first, its parts' bytes added up and refused past `maxBytes` before any
 * part is read; then each part checked against the manifest's size and sum
 * before it is opened and handed to `onPart`, and let go before the next.
 * Throws on the first part missing or different, after the parts before it
 * were handed on: a restore that must write all or nothing reads the set
 * twice, first checking every key of every part, then writing.
 */
export async function readBackupSet(
  manifestId: string,
  key: Uint8Array,
  store: BackupObjectStore,
  maxBytes: number,
  onPart: (snapshot: BackupSnapshot, index: number) => Promise<void>,
): Promise<BackupManifest> {
  const manifest = openManifest(await store.read(manifestId, manifestBound(MAX_PARTS)), key);
  const total = manifest.parts.reduce((n, part) => n + part.bytes, 0);
  if (!Number.isSafeInteger(maxBytes) || maxBytes <= 0 || total > maxBytes) throw new Error("Backup set exceeds the bytes a restore may read");
  for (const [index, part] of manifest.parts.entries()) {
    const read = await store.read(part.id, PART_MAX_BYTES + PART_SEAL_ROOM);
    if (read.byteLength !== part.bytes || sha256(read) !== part.sha256) throw new Error("Backup part differs from its manifest");
    const snapshot = openBackup(read, key);
    if (snapshot.capturedAt !== manifest.capturedAt || snapshot.rows.length !== part.rows) throw new Error("Backup part does not match its manifest");
    await onPart(snapshot, index);
  }
  return manifest;
}
