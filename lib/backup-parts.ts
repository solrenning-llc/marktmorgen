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
 * - Nothing here is ever deleted or replaced: a run that fails leaves the parts
 *   it wrote as unreferenced objects (no manifest names them) and every earlier
 *   verified set as it was. The run deletes every object past the retention
 *   before its next copy (lib/backup-run.ts); the bucket's lifecycle rule is a
 *   safety net.
 * - The walk reads at most BACKUP_SCAN_PAGES pages; a walk not done by then
 *   is refused ("scan_pages") before anything is written.
 * - Inside a cutoff (lib/fetch-timeout.ts, withCutoff; the run's is
 *   BACKUP_RUN_CUTOFF_MS), no page, batch, part or manifest is begun after it
 *   ("cutoff"); outside one there is none.
 * - The walk's and the copy's commands are counted against the run's cap
 *   before the first DUMP; the parts and the bytes are counted as the copy
 *   goes, each row at the bytes it adds to its part's JSON: a database larger
 *   than the run may copy is refused, never written as a whole set.
 *
 * - A key larger than a part (9 November 2026: the affiliate book's snapshot
 *   under nl:aff: may take 8,000,000 bytes) is copied in chunks over
 *   consecutive parts, each chunk with the key's whole DUMP length and SHA-256
 *   (lib/backup-codec.ts, BackupChunk): the chunk that begins it is the first
 *   row of its part, every chunk but the last the only one, and the last the
 *   first row of its part. readBackupSet joins them and checks the length, the
 *   sum and the order before it hands the whole row on; a chunk missing, moved
 *   or changed stops the read. A key whose DUMP is over BACKUP_KEY_MAX_BYTES is
 *   never cut short: it is left out, the rest is still written and verified,
 *   and the manifest says how many were left out (version 2, "missing"), so the
 *   copy is "key_over_ceiling", never a whole set, and readBackupSet refuses it
 *   unless asked to read it knowingly as incomplete. Its bytes, read by DUMP,
 *   still count against the run's maxRunBytes.
 *
 * - A copy may stop at a deadline and go on in a later run (C1-20261109-1525-C4-68 item 3): with `stopAt`, no key is
 *   begun at or after it; the open part is closed (written and read back) and the copy comes back "paused" with its
 *   progress: the last key name handled (`after`), the parts written so far and the counts. Given that progress as
 *   `resume`, the next copy walks the database again and copies only the names after `after`, in the same order, into
 *   new parts sealed with the same moment (`now`, the copy's start), then the manifest names every part. A pause
 *   needs a part left for the rest of the copy: with none, the copy is "too_many_parts" at once, never a progress that
 *   could not close. A key in chunks is never cut by a pause: when its chunks could not be closed before `stopAt`
 *   (`partMs` each), the copy pauses before it.
 *
 * Server-only. Built and off: nothing schedules it (lib/backup-run.ts).
 */
import { createHash, randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { gunzipSync, gzipSync } from "node:zlib";
import { BACKUP_KEY_MAX_BYTES, openPart, openSealed, sealPart, sealWithKid, type BackupChunkRow, type BackupKeys, type BackupPart, type BackupRow, type BackupSnapshot, type SealFormat } from "@/lib/backup-codec";
import { BACKUP_MAX_BYTES, BACKUP_MAX_ROWS, BACKUP_PREFIX } from "@/lib/backup-export";
import type { BackupObjectStore } from "@/lib/backup-roundtrip";
import { timeLeft } from "@/lib/fetch-timeout";
import { redisPipeline, redisPipelineBase64 } from "@/lib/redis";

export { BACKUP_KEY_MAX_BYTES };

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
/**
 * The most SCAN pages one walk reads (inbox C4-46). At 500 names a page asked for, 200 pages walk 100,000 names of the
 * whole database, ten times the design's 10,000 keys of ours, so the cap leaves room for other products' keys in a
 * shared database; it bounds what the walk may move (lib/backup-cost.ts). A walk whose cursor has not come back to "0"
 * by then is refused as "scan_pages" before anything is written: a partial copy never passes as a whole one.
 */
export const BACKUP_SCAN_PAGES = 200;
/** The longest key the backup format keeps (lib/backup-codec.ts), in bytes. */
const KEY_MAX_BYTES = 1_024;
// Linear (9 November 2026): the quad-grouped pattern overflows V8's regexp stack past about 5 million characters,
// which a key in chunks reaches (a DUMP of 8 MB is 10.7 million); the length and the round trip do the rest.
const BASE64_CHARS = /^[A-Za-z0-9+/]*={0,2}$/;
const BASE64 = { test: (text: string) => text.length % 4 === 0 && BASE64_CHARS.test(text) };
/** The manifest's two formats (lib/backup-codec.ts): the older one, and the one with the key id after the magic. */
const MANIFEST_FORMAT: SealFormat = {
  magicV1: Buffer.from("MMBM1"),
  aadV1: Buffer.from("marktmorgen/backup-manifest/v1"),
  magic: Buffer.from("MMBM2"),
  aad: Buffer.from("marktmorgen/backup-manifest/v2"),
};

/**
 * True when `bytes` begin as a manifest does, in either format: such an object that does not open is a manifest under
 * a key the reader lacks, or a damaged one, and never "not a manifest" (inbox C4-36 item 3).
 */
export function isManifestEnvelope(bytes: Uint8Array): boolean {
  const head = Buffer.from(bytes.subarray(0, 5));
  return head.equals(MANIFEST_FORMAT.magicV1) || head.equals(MANIFEST_FORMAT.magic);
}

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
  /** The moment (Date.now()) at and after which no key is begun: the copy pauses. Absent: it never pauses. */
  stopAt?: number;
  /** How long one part may take to close (written and read back), for a key in chunks begun before stopAt. */
  partMs?: number;
  /** Where an earlier, paused copy stopped (validProgress): the copy goes on from there. */
  resume?: CopyProgress;
  /** The moment a key's end is compared with, when it is not `now` (a resumed copy keeps its start as `now`). */
  readAt?: number;
};

/**
 * Where a paused copy stopped: the last key name it handled (null before the first), every part it wrote and read
 * back, and its counts so far (rows in those parts, keys copied, keys left out over the ceiling, bytes counted
 * against maxRunBytes).
 */
export type CopyProgress = { after: string | null; parts: PartEntry[]; rows: number; keys: number; missing: number; bytes: number };

export type PartEntry = { id: string; rows: number; bytes: number; sha256: string };
/**
 * A set's manifest: `rows` counts the rows of its parts (a chunked key's chunks each). Version 2 is a set with keys
 * left out over BACKUP_KEY_MAX_BYTES, `missing` how many: a reader that knows only version 1 refuses it, never taking
 * it for a whole set.
 */
export type BackupManifest = { version: 1; capturedAt: number; parts: PartEntry[]; rows: number } | { version: 2; capturedAt: number; parts: PartEntry[]; rows: number; missing: number };

type PartsFailure = "limits" | "budget" | "cutoff" | "scan_pages" | "too_many" | "too_big" | "too_many_parts" | "unreadable" | "error" | "verify";
export type PartsResult =
  | { ok: true; id: string; keys: number; bytes: number; parts: number; commands: number }
  /** Stopped at `stopAt`: never a set (no manifest), its parts verified, the progress to go on from. */
  | { ok: false; reason: "paused"; progress: CopyProgress; commands: number; parts: number }
  /** Every other key copied and the set verified, with `missing` keys over BACKUP_KEY_MAX_BYTES left out: never whole. */
  | { ok: false; reason: "key_over_ceiling"; id: string; missing: number; keys: number; bytes: number; parts: number; commands: number }
  | { ok: false; reason: PartsFailure; commands: number; parts: number };

/** A set read back that left keys out (manifest version 2), refused unless read knowingly as incomplete. */
export class BackupSetIncompleteError extends Error {
  constructor(readonly missing: number) {
    super(`Backup set is incomplete: ${missing} key(s) over the ceiling were left out`);
    this.name = "BackupSetIncompleteError";
  }
}

const whole = (n: unknown, most = Number.MAX_SAFE_INTEGER) => typeof n === "number" && Number.isSafeInteger(n) && n > 0 && n <= most;
const sha256 = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");

/** The most a stored manifest of `parts` entries may weigh. */
export const manifestBound = (parts: number) => parts * MANIFEST_ENTRY_BYTES + MANIFEST_ROOM;
/** The most one run's stored objects may weigh: every part sealed, and the manifest. */
export const runStoredBound = (limits: Pick<PartsLimits, "maxParts" | "maxRunBytes">) => limits.maxRunBytes + limits.maxParts * PART_SEAL_ROOM + manifestBound(limits.maxParts);

function validManifest(raw: unknown): BackupManifest {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error("Invalid manifest");
  const m = raw as Partial<BackupManifest> & { missing?: unknown };
  // Version 2 only with keys left out, version 1 only without: the count is never absent from an incomplete set.
  const missingFine = m.version === 1 ? !("missing" in m) : m.version === 2 && Number.isSafeInteger(m.missing) && Number(m.missing) >= 1 && Number(m.missing) <= 1_000_000;
  if (!missingFine || !Number.isSafeInteger(m.capturedAt) || Number(m.capturedAt) < 0 || !Array.isArray(m.parts) || m.parts.length > MAX_PARTS || !Number.isSafeInteger(m.rows)) {
    throw new Error("Invalid manifest");
  }
  if (rowsOfParts(m.parts) !== m.rows) throw new Error("Invalid manifest rows");
  return m as BackupManifest;
}

/** The rows of a list of part entries, each checked in its shape and none twice; throws on any other. */
function rowsOfParts(parts: readonly unknown[]): number {
  const ids = new Set<string>();
  let rows = 0;
  for (const raw of parts) {
    const part = raw as Partial<PartEntry> | null;
    if (!part || typeof part !== "object" || typeof part.id !== "string" || !/^[0-9a-f-]{36}$/.test(part.id) || ids.has(part.id) ||
        !Number.isSafeInteger(part.rows) || Number(part.rows) < 0 || Number(part.rows) > PART_MAX_ROWS ||
        !Number.isSafeInteger(part.bytes) || Number(part.bytes) < 34 || Number(part.bytes) > PART_MAX_BYTES + PART_SEAL_ROOM ||
        typeof part.sha256 !== "string" || !/^[0-9a-f]{64}$/.test(part.sha256)) throw new Error("Invalid manifest part");
    ids.add(part.id);
    rows += Number(part.rows);
  }
  return rows;
}

const count = (n: unknown) => typeof n === "number" && Number.isSafeInteger(n) && n >= 0;

/**
 * A paused copy's progress read back exactly (rule 24): every field in its shape, the parts as a manifest names them,
 * their rows the count; anything else throws, never "no progress".
 */
export function validProgress(raw: unknown): CopyProgress {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error("Invalid progress");
  const p = raw as Partial<CopyProgress>;
  const fields = Object.keys(p).sort().join(",");
  if (fields !== "after,bytes,keys,missing,parts,rows") throw new Error("Invalid progress");
  if (p.after !== null && (typeof p.after !== "string" || !p.after.startsWith(BACKUP_PREFIX) || Buffer.byteLength(p.after, "utf8") > KEY_MAX_BYTES)) throw new Error("Invalid progress");
  if (!Array.isArray(p.parts) || p.parts.length > MAX_PARTS || ![p.rows, p.keys, p.missing, p.bytes].every(count)) throw new Error("Invalid progress");
  if (rowsOfParts(p.parts) !== p.rows) throw new Error("Invalid progress rows");
  return { after: p.after, parts: p.parts.map(({ id, rows, bytes, sha256 }) => ({ id, rows, bytes, sha256 })), rows: p.rows!, keys: p.keys!, missing: p.missing!, bytes: p.bytes! };
}

/** The manifest, sealed as the parts are (AES-256-GCM over gzip, with the key id), under its own magic and associated data. */
export function sealManifest(manifest: BackupManifest, key: Uint8Array): Buffer {
  if (!(key instanceof Uint8Array) || key.byteLength !== 32) throw new Error("Invalid backup key");
  const plain = Buffer.from(JSON.stringify(validManifest(manifest)));
  if (plain.length > manifestBound(manifest.parts.length)) throw new Error("Manifest exceeds its bound");
  return sealWithKid(MANIFEST_FORMAT, key, gzipSync(plain));
}

/** A manifest opened with the key whose id its header names, from one key or a keyring (lib/backup-codec.ts). */
export function openManifest(sealed: Uint8Array, keys: BackupKeys): BackupManifest {
  const blob = Buffer.from(sealed);
  if (blob.length < 34 || blob.length > manifestBound(MAX_PARTS)) throw new Error("Invalid manifest envelope");
  // Authenticated before it is unpacked or read.
  const packed = openSealed(MANIFEST_FORMAT, keys, blob);
  return validManifest(JSON.parse(gunzipSync(packed, { maxOutputLength: manifestBound(MAX_PARTS) }).toString("utf8")));
}

/** One part sealed, written create-only and read back the same; its entry for the manifest. */
async function putPart(snapshot: BackupPart, key: Uint8Array, store: BackupObjectStore): Promise<PartEntry> {
  const sealed = sealPart(snapshot, key);
  if (sealed.length > PART_MAX_BYTES + PART_SEAL_ROOM) throw new Error("Part exceeds its bound");
  const id = randomUUID();
  await store.putNew(id, sealed);
  const read = await store.read(id, PART_MAX_BYTES + PART_SEAL_ROOM);
  if (read.byteLength !== sealed.length || sha256(read) !== sha256(sealed)) throw new Error("Part read-back differs");
  if (!isDeepStrictEqual(openPart(read, key), snapshot)) throw new Error("Part read-back mismatch");
  return { id, rows: snapshot.rows.length, bytes: read.byteLength, sha256: sha256(read) };
}

/**
 * Every key of ours, copied as a set of verified parts and a verified
 * manifest; or a refusal that says why, with how many commands were sent and
 * parts written. Never throws.
 */
export async function copyInParts(limits: PartsLimits, key: Uint8Array, store: BackupObjectStore): Promise<PartsResult> {
  const { maxRows, maxCommands, maxParts, maxRunBytes, batch, now, partBytes = PART_MAX_BYTES, stopAt, partMs = 0, readAt = now } = limits;
  if (!whole(maxRows) || !whole(maxCommands) || !whole(maxParts, MAX_PARTS) || !whole(maxRunBytes) || !whole(batch, 500) || !whole(now) || !whole(partBytes, PART_MAX_BYTES) || partBytes <= 1_024 || key.byteLength !== 32) {
    return { ok: false, reason: "limits", commands: 0, parts: 0 };
  }
  if ((stopAt !== undefined && !whole(stopAt)) || !count(partMs) || !whole(readAt)) return { ok: false, reason: "limits", commands: 0, parts: 0 };
  let resume: CopyProgress | null;
  try {
    resume = limits.resume === undefined ? null : validProgress(limits.resume);
  } catch {
    return { ok: false, reason: "limits", commands: 0, parts: 0 };
  }
  let commands = 0;
  // A resumed copy's parts first: the manifest names them before this run's.
  const entries: PartEntry[] = resume ? [...resume.parts] : [];
  if (entries.length > maxParts) return { ok: false, reason: "too_many_parts", commands: 0, parts: entries.length };
  const fail = (reason: PartsFailure): PartsResult => ({ ok: false, reason, commands, parts: entries.length });
  // Which side a throw came from: the database while reading ("error"), or a part or the manifest being sealed,
  // written or read back ("verify").
  let writing = false;
  try {
    // The walk: every name of ours, each SCAN counted before it is sent, at most BACKUP_SCAN_PAGES pages.
    const keys = new Set<string>();
    let cursor = "0";
    let pages = 0;
    do {
      if (pages === BACKUP_SCAN_PAGES) return fail("scan_pages");
      if (timeLeft() <= 0) return fail("cutoff");
      if (commands + 1 > maxCommands) return fail("budget");
      const [reply] = await redisPipeline([["SCAN", cursor, "MATCH", `${BACKUP_PREFIX}*`, "COUNT", SCAN_COUNT]]);
      commands += 1;
      pages += 1;
      if (!Array.isArray(reply) || reply.length !== 2 || typeof reply[0] !== "string" || !Array.isArray(reply[1])) return fail("unreadable");
      for (const name of reply[1]) {
        if (typeof name !== "string" || name.includes("�")) return fail("unreadable");
        if (!name.startsWith(BACKUP_PREFIX)) continue;
        // A key of ours the format cannot keep: refused before anything is copied, never found out by a failed seal.
        if (Buffer.byteLength(name, "utf8") > KEY_MAX_BYTES) return fail("too_big");
        keys.add(name);
        if (keys.size > maxRows) return fail("too_many");
      }
      if (reply[0] !== "0" && reply[0] === cursor) return fail("unreadable");
      cursor = reply[0];
    } while (cursor !== "0");

    // A resumed copy goes on after the last name the paused one handled, in the same order.
    const after = resume?.after ?? null;
    const sorted = [...keys].sort().filter((name) => after === null || name > after);
    // Decided before any DUMP: the whole rest of the copy fits the run's commands, or nothing is copied.
    if (commands + 2 * sorted.length > maxCommands) return fail("budget");

    let rows: BackupPart["rows"] = [];
    let filled = 0;
    let runBytes = resume?.bytes ?? 0;
    let copied = resume?.rows ?? 0;
    // Keys copied (a chunked key once), and keys left out over BACKUP_KEY_MAX_BYTES.
    let keysCopied = resume?.keys ?? 0;
    let missing = resume?.missing ?? 0;
    // The last name handled (copied, gone, ended or left out): where a pause says the next copy goes on from.
    let last = after;
    const close = async () => {
      if (rows.length === 0) return;
      if (entries.length + 1 > maxParts) throw new RangeError("too_many_parts");
      if (timeLeft() <= 0) throw new RangeError("cutoff");
      writing = true;
      entries.push(await putPart({ version: 1, capturedAt: now, rows }, key, store));
      writing = false;
      copied += rows.length;
      rows = [];
      filled = 0;
    };
    // At the deadline: the open part closed, and the progress handed back. A pause needs the part it closes and one
    // more for the rest of the copy, or the copy could never close: "too_many_parts" at once.
    const pause = async (): Promise<PartsResult> => {
      if (entries.length + (rows.length > 0 ? 1 : 0) + 1 > maxParts) return fail("too_many_parts");
      await close();
      return { ok: false, reason: "paused", progress: { after: last, parts: [...entries], rows: copied, keys: keysCopied, missing, bytes: runBytes }, commands, parts: entries.length };
    };
    for (let at = 0; at < sorted.length; at += batch) {
      if (timeLeft() <= 0) return fail("cutoff");
      if (stopAt !== undefined && Date.now() >= stopAt) return await pause();
      const names = sorted.slice(at, at + batch);
      const replies = await redisPipelineBase64(names.flatMap((name) => [["DUMP", name], ["PEXPIRETIME", name]]));
      commands += 2 * names.length;
      if (replies.length !== 2 * names.length) return fail("unreadable");
      for (let i = 0; i < names.length; i += 1) {
        const dump = replies[2 * i];
        // Read exactly (CX-123 rule 24, Codex Q): PEXPIRETIME answers an integer; anything else (nil, a text, a list)
        // is unknown and refused below, never read as 0 ("ended long ago") and the key left out of the backup.
        const reply = replies[2 * i + 1];
        const ends = typeof reply === "number" ? reply : Number.NaN;
        // Gone between the walk and its copy (DUMP answered nil): left out, never copied empty.
        if (dump === null) {
          last = names[i];
          continue;
        }
        // The ending is checked in its shape before it can leave a key out (Codex G on #2734): a safe integer, either
        // -1 (no ending), -2 (gone) or a time; -3, a fraction, -Infinity or an unsafe integer is unknown and refused.
        if (!Number.isSafeInteger(ends) || ends < -2) return fail("unreadable");
        // Gone, or ended by the time of the copy: left out.
        if (ends === -2 || (ends !== -1 && ends <= readAt)) {
          last = names[i];
          continue;
        }
        if (typeof dump !== "string" || !dump || !BASE64.test(dump)) return fail("unreadable");
        const raw = Buffer.from(dump, "base64");
        if (raw.toString("base64") !== dump) return fail("unreadable");
        const row: BackupRow = { key: names[i], dump, expiresAt: ends === -1 ? null : ends };
        // The bytes it adds to its part's JSON, escapes and UTF-8 included, and its comma.
        const size = Buffer.byteLength(JSON.stringify(row), "utf8") + 1;
        // Read by DUMP whatever becomes of it: its bytes count against the run's cap (lib/backup-cost.ts prices them).
        if (runBytes + size > maxRunBytes) return fail("too_big");
        // Over the ceiling: left out whole, never cut short, and counted, so the set is never taken for a whole one.
        if (raw.length > BACKUP_KEY_MAX_BYTES) {
          missing += 1;
          runBytes += size;
          last = names[i];
          continue;
        }
        if (size > partBytes - 1_024) {
          // Larger than a part: chunks over consecutive parts, the first beginning a part, each but the last alone in
          // its part, each with the key's whole length and sum.
          await close();
          const base = { key: names[i], expiresAt: row.expiresAt };
          const room = partBytes - 1_024 - (Buffer.byteLength(JSON.stringify({ ...base, chunk: { at: MAX_PARTS, of: MAX_PARTS, bytes: raw.length, sha256: "0".repeat(64), data: "" } }), "utf8") + 1);
          const piece = Math.floor(room / 4) * 4;
          if (piece < 4) return fail("too_big");
          const of = Math.ceil(dump.length / piece);
          if (of < 2 || of > MAX_PARTS) return fail("too_big");
          // Its chunks close of - 1 parts before the last one stays open: begun only when they can close before the
          // deadline, so a pause never cuts a key; otherwise the copy pauses before it.
          if (stopAt !== undefined && Date.now() + (of - 1) * partMs >= stopAt) return await pause();
          const sum = sha256(raw);
          for (let at = 0; at < of; at += 1) {
            const chunk: BackupChunkRow = { ...base, chunk: { at, of, bytes: raw.length, sha256: sum, data: dump.slice(at * piece, (at + 1) * piece) } };
            rows.push(chunk);
            filled += Buffer.byteLength(JSON.stringify(chunk), "utf8") + 1;
            // The last chunk leaves its part open for the rows after it.
            if (at < of - 1) await close();
          }
          // Its chunks' framing beyond the row's own bytes, counted too.
          runBytes += size + of * (Buffer.byteLength(JSON.stringify({ ...base, chunk: { at: 0, of, bytes: raw.length, sha256: sum, data: "" } }), "utf8") + 1);
          if (runBytes > maxRunBytes) return fail("too_big");
          keysCopied += 1;
          last = names[i];
          continue;
        }
        if (filled + size > partBytes - 1_024 || rows.length + 1 > PART_MAX_ROWS) await close();
        rows.push(row);
        filled += size;
        runBytes += size;
        keysCopied += 1;
        last = names[i];
      }
    }
    await close();

    // The manifest last: the set is one only when it is read back naming every part and its sums, and never after the
    // run's cutoff (lib/backup-run.ts), so a run's writes all land before it.
    if (timeLeft() <= 0) return fail("cutoff");
    writing = true;
    const manifest: BackupManifest = missing > 0 ? { version: 2, capturedAt: now, parts: entries, rows: copied, missing } : { version: 1, capturedAt: now, parts: entries, rows: copied };
    const sealed = sealManifest(manifest, key);
    const id = randomUUID();
    await store.putNew(id, sealed);
    const read = await store.read(id, manifestBound(entries.length));
    if (!isDeepStrictEqual(openManifest(read, key), manifest)) return fail("verify");
    const bytes = entries.reduce((n, part) => n + part.bytes, 0) + read.byteLength;
    // A key left out: the rest is a verified set, but never a whole one (rule 24).
    if (missing > 0) return { ok: false, reason: "key_over_ceiling", id, missing, keys: keysCopied, bytes, parts: entries.length, commands };
    return { ok: true, id, keys: keysCopied, bytes, parts: entries.length, commands };
  } catch (error) {
    if (error instanceof RangeError && error.message === "too_many_parts") return fail("too_many_parts");
    // The run's cutoff passed, here or inside a request given up at it: said as such.
    if ((error instanceof RangeError && error.message === "cutoff") || timeLeft() <= 0) return fail("cutoff");
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
 * before it is opened and handed to `onPart` with whole rows only, and let go
 * before the next. A key in chunks is joined from consecutive parts and handed
 * on with the part of its last chunk, only once its length, SHA-256 and
 * base64 are the ones its chunks name; a part holding only a middle chunk is
 * handed on with no rows. Throws on the first part missing or different, a
 * chunk out of place, or a key whose sum differs, after the parts before it
 * were handed on: a restore that must write all or nothing reads the set
 * twice, first checking every key of every part, then writing. A manifest
 * whose id has a folder (a month's copy, monthly/<YYYY-MM>/<run>/<uuid>,
 * lib/backup-store.ts) names parts in that same folder. A set that left keys
 * out (manifest version 2) is refused (BackupSetIncompleteError) unless
 * `options.allowIncomplete` asks to read it knowingly as incomplete.
 */
export async function readBackupSet(
  manifestId: string,
  key: BackupKeys,
  store: BackupObjectStore,
  maxBytes: number,
  onPart: (snapshot: BackupSnapshot, index: number) => Promise<void>,
  options: { allowIncomplete?: boolean } = {},
): Promise<BackupManifest> {
  const manifest = openManifest(await store.read(manifestId, manifestBound(MAX_PARTS)), key);
  if (manifest.version === 2 && options.allowIncomplete !== true) throw new BackupSetIncompleteError(manifest.missing);
  const total = manifest.parts.reduce((n, part) => n + part.bytes, 0);
  if (!Number.isSafeInteger(maxBytes) || maxBytes <= 0 || total > maxBytes) throw new Error("Backup set exceeds the bytes a restore may read");
  const folder = manifestId.slice(0, manifestId.lastIndexOf("/") + 1);
  // The key whose chunks are being joined, if any.
  let open: { key: string; expiresAt: number | null; of: number; bytes: number; sha256: string; pieces: string[] } | null = null;
  for (const [index, part] of manifest.parts.entries()) {
    const read = await store.read(folder + part.id, PART_MAX_BYTES + PART_SEAL_ROOM);
    if (read.byteLength !== part.bytes || sha256(read) !== part.sha256) throw new Error("Backup part differs from its manifest");
    const snapshot = openPart(read, key);
    if (snapshot.capturedAt !== manifest.capturedAt || snapshot.rows.length !== part.rows) throw new Error("Backup part does not match its manifest");
    const rows: BackupRow[] = [];
    for (const [at, row] of snapshot.rows.entries()) {
      if (!("chunk" in row)) {
        if (open) throw new Error("Backup chunk interrupted");
        rows.push(row);
        continue;
      }
      const chunk = row.chunk;
      // Every chunk is the first row of its part: the first begins a key, each one after continues it in the next part.
      if (at !== 0) throw new Error("Backup chunk out of place");
      if (chunk.at === 0) {
        if (open) throw new Error("Backup chunk interrupted");
        open = { key: row.key, expiresAt: row.expiresAt, of: chunk.of, bytes: chunk.bytes, sha256: chunk.sha256, pieces: [] };
      } else if (!open || open.key !== row.key || open.expiresAt !== row.expiresAt || open.of !== chunk.of || open.bytes !== chunk.bytes || open.sha256 !== chunk.sha256 || open.pieces.length !== chunk.at) {
        throw new Error("Backup chunk out of order");
      }
      open.pieces.push(chunk.data);
      if (chunk.at < chunk.of - 1) {
        // Every chunk but the last is alone in its part.
        if (snapshot.rows.length !== 1) throw new Error("Backup chunk out of place");
        continue;
      }
      const dump = open.pieces.join("");
      const bytes = Buffer.from(dump, "base64");
      if (bytes.length !== open.bytes || sha256(bytes) !== open.sha256 || bytes.toString("base64") !== dump) throw new Error("Backup chunked key differs from its sum");
      rows.push({ key: open.key, dump, expiresAt: open.expiresAt });
      open = null;
    }
    await onPart({ version: 1, capturedAt: snapshot.capturedAt, rows }, index);
  }
  if (open) throw new Error("Backup chunked key cut short");
  return manifest;
}
