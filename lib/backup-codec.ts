import { createCipheriv, createDecipheriv, createHmac, randomBytes } from "node:crypto";
import { gzipSync, gunzipSync } from "node:zlib";

// Offline codec only. No provider adapter, scheduler, secrets lookup or network.
// Limits bound memory for synthetic restore; they do not authorize production.
// Inbox C4-36 item 3: every object sealed since 8 November 2026 carries the key's id (BACKUP_KID_BYTES of
// HMAC-SHA256(key, "mm-backup-kid")) after its magic, bound into the associated data, so a reader picks the key that
// sealed it from a keyring (the current key and, after a rotation, the previous one) and a key id changed in the header
// fails authentication. Objects of the older format (MMBK1, no key id) still open, with each key of the keyring tried.
const MAGIC_V1 = Buffer.from("MMBK1");
const MAGIC = Buffer.from("MMBK2");
const MAX = 4 * 1024 * 1024;
const AAD_V1 = Buffer.from("marktmorgen/backup/v1");
const AAD = Buffer.from("marktmorgen/backup/v2");
/** Bytes of the key id in the header: the first 4 of HMAC-SHA256(key, "mm-backup-kid"). */
export const BACKUP_KID_BYTES = 4;
/** One key, or a keyring: the current key first, then any key a reader may still open with. */
export type BackupKeys = Uint8Array | readonly Uint8Array[];
/** An object sealed under a key id no key of the keyring has: not opened, never taken as another kind of object. */
export class BackupKeyUnknownError extends Error {
 constructor(){ super("Backup sealed under a key this keyring does not hold"); this.name="BackupKeyUnknownError"; }
}
export type BackupRow = { key: string; dump: string; expiresAt: number | null };
export type BackupSnapshot = { version: 1; capturedAt: number; rows: BackupRow[] };
/**
 * The most one key's DUMP may weigh in a backup, in bytes (key-size inventory of 9 November 2026): the largest proven
 * writer is the affiliate book's snapshot under nl:aff:, 8,000,000 bytes (lib/affiliate-book-snapshot.ts,
 * BOOK_SNAPSHOT_MAX_BYTES), and 12 MiB leaves it more than half again for DUMP's framing and a hash's per-field
 * encoding. Upstash's own record cap (100 MiB) is far above it. A key larger than a part is copied in chunks up to
 * this ceiling (lib/backup-parts.ts); one past it is left out under its own state, never cut short.
 */
export const BACKUP_KEY_MAX_BYTES = 12 * 1024 * 1024;
/**
 * One piece of a key larger than a part (lib/backup-parts.ts): its place `at` of `of` pieces, the key's whole DUMP
 * length in bytes and SHA-256, and this piece of its base64. A chunk row has no `dump`, so a reader that knows only
 * whole rows (openBackup, restoreRows, an older offline tool) refuses the part rather than take a piece for a key.
 */
export type BackupChunk = { at: number; of: number; bytes: number; sha256: string; data: string };
export type BackupChunkRow = { key: string; expiresAt: number | null; chunk: BackupChunk };
/** One part of a set in parts: whole rows, and the chunks of keys larger than a part. */
export type BackupPart = { version: 1; capturedAt: number; rows: (BackupRow | BackupChunkRow)[] };
// Linear (9 November 2026): the quad-grouped pattern overflows V8's regexp stack past about 5 million characters,
// which a key in chunks reaches (a DUMP of 8 MB is 10.7 million); the length and the round trip do the rest.
const BASE64_CHARS = /^[A-Za-z0-9+/]*={0,2}$/;
const BASE64 = { test: (text: string) => text.length % 4 === 0 && BASE64_CHARS.test(text) };
const canonical = (text: unknown): text is string => typeof text === "string" && text.length > 0 && BASE64.test(text) && Buffer.from(text,"base64").toString("base64") === text;
function validChunk(raw: unknown): raw is BackupChunk {
 if (!raw || typeof raw !== "object" || Array.isArray(raw)) return false;
 const c = raw as Partial<BackupChunk>;
 const last = c.at === Number(c.of) - 1;
 return Number.isSafeInteger(c.of) && Number(c.of) >= 2 && Number(c.of) <= 10_000 && Number.isSafeInteger(c.at) && Number(c.at) >= 0 && Number(c.at) < Number(c.of) &&
  Number.isSafeInteger(c.bytes) && Number(c.bytes) > 0 && Number(c.bytes) <= BACKUP_KEY_MAX_BYTES &&
  typeof c.sha256 === "string" && /^[0-9a-f]{64}$/.test(c.sha256) &&
  // Every piece but the last is whole base64 quads with no padding, so the pieces joined are the key's base64.
  canonical(c.data) && (last || !c.data.endsWith("="));
}
function validate(raw: unknown, chunks = false): BackupSnapshot {
 if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error("Invalid backup");
 const x = raw as Partial<BackupPart>;
 if (x.version !== 1 || !Number.isSafeInteger(x.capturedAt) || Number(x.capturedAt) < 0 || !Array.isArray(x.rows) || x.rows.length > 10000) throw new Error("Invalid backup");
 const keys = new Set<string>();
 for (const row of x.rows) {
  if (!row || typeof row !== "object" || Array.isArray(row) || typeof row.key !== "string" ||
      !row.key.startsWith("nl:") || Buffer.byteLength(row.key) > 1024 || keys.has(row.key) ||
      (row.expiresAt !== null && (!Number.isSafeInteger(row.expiresAt) || row.expiresAt <= Number(x.capturedAt)))) throw new Error("Invalid backup row");
  // A chunk only where the caller reads parts (openPart); everywhere else a row without a whole dump is refused.
  if ("dump" in row ? !canonical(row.dump) || "chunk" in row : !chunks || !validChunk((row as BackupChunkRow).chunk)) throw new Error("Invalid backup row");
  keys.add(row.key);
 }
 return x as BackupSnapshot;
}
function validKey(key: Uint8Array) {
 if (!(key instanceof Uint8Array) || key.byteLength !== 32) throw new Error("Invalid backup key");
}
/** The keyring as a list, every key checked: one key, or the current key first and then the others. */
export function keysOf(keys: BackupKeys): Uint8Array[] {
 const list = keys instanceof Uint8Array ? [keys] : [...keys];
 if (list.length === 0) throw new Error("Invalid backup key");
 for (const key of list) validKey(key);
 return list;
}
/** A key's id in the header: the first BACKUP_KID_BYTES bytes of HMAC-SHA256(key, "mm-backup-kid"). */
export function backupKid(key: Uint8Array): Buffer {
 validKey(key);
 return createHmac("sha256",key).update("mm-backup-kid").digest().subarray(0,BACKUP_KID_BYTES);
}
/** What the report shows of a key (inbox C4-36 item 2): its id as 8 hex, never the key. */
export const backupKeyFingerprint = (key: Uint8Array): string => backupKid(key).toString("hex");

/** A sealed envelope's two formats: the older one (magic, nonce, tag) and the one with the key id after the magic. */
export type SealFormat = { magicV1: Buffer; aadV1: Buffer; magic: Buffer; aad: Buffer };
const PART_FORMAT: SealFormat = { magicV1: MAGIC_V1, aadV1: AAD_V1, magic: MAGIC, aad: AAD };

/** `packed` sealed under `key` in the current format: magic, key id, nonce, tag, AES-256-GCM over magic's own AAD and the key id. */
export function sealWithKid(format: SealFormat, key: Uint8Array, packed: Buffer): Buffer {
 const kid = backupKid(key);
 const nonce = randomBytes(12);
 const cipher = createCipheriv("aes-256-gcm",key,nonce);
 cipher.setAAD(Buffer.concat([format.aad,kid]));
 const encrypted = Buffer.concat([cipher.update(packed),cipher.final()]);
 return Buffer.concat([format.magic,kid,nonce,cipher.getAuthTag(),encrypted]);
}
const decrypt = (key: Uint8Array, aad: Buffer, nonce: Buffer, tag: Buffer, body: Buffer) => {
 const decipher = createDecipheriv("aes-256-gcm",key,nonce);
 decipher.setAAD(aad);
 decipher.setAuthTag(tag);
 return Buffer.concat([decipher.update(body),decipher.final()]);
};
/**
 * What `blob` holds, authenticated before anything else is read: in the current format with the key whose id is in its
 * header (BackupKeyUnknownError when the keyring has none), in the older one with the first key that authenticates it.
 */
export function openSealed(format: SealFormat, keys: BackupKeys, blob: Buffer): Buffer {
 const ring = keysOf(keys);
 if (blob.length >= 34 && blob.subarray(0,5).equals(format.magicV1)) {
  for (const key of ring) {
   try { return decrypt(key,format.aadV1,blob.subarray(5,17),blob.subarray(17,33),blob.subarray(33)); } catch { /* the next key */ }
  }
  throw new Error("Invalid backup envelope");
 }
 if (blob.length < 5+BACKUP_KID_BYTES+28 || !blob.subarray(0,5).equals(format.magic)) throw new Error("Invalid backup envelope");
 const kid = blob.subarray(5,5+BACKUP_KID_BYTES);
 const key = ring.find((candidate)=>backupKid(candidate).equals(kid));
 if (!key) throw new BackupKeyUnknownError();
 const at = 5+BACKUP_KID_BYTES;
 return decrypt(key,Buffer.concat([format.aad,kid]),blob.subarray(at,at+12),blob.subarray(at+12,at+28),blob.subarray(at+28));
}
export function sealBackup(snapshot: BackupSnapshot, key: Uint8Array): Buffer {
 validKey(key);
 const plain = Buffer.from(JSON.stringify(validate(snapshot)));
 if (plain.length > MAX) throw new Error("Backup exceeds codec bound");
 return sealWithKid(PART_FORMAT,key,gzipSync(plain));
}
/** A part of a set in parts, whole rows and chunks, sealed as sealBackup seals (lib/backup-parts.ts). */
export function sealPart(part: BackupPart, key: Uint8Array): Buffer {
 validKey(key);
 const plain = Buffer.from(JSON.stringify(validate(part,true)));
 if (plain.length > MAX) throw new Error("Backup exceeds codec bound");
 return sealWithKid(PART_FORMAT,key,gzipSync(plain));
}
/** A part opened as openBackup opens, its chunks kept as chunks: lib/backup-parts.ts joins and checks them. */
export function openPart(sealed: Uint8Array, keys: BackupKeys): BackupPart {
 const ring = keysOf(keys);
 const blob = Buffer.from(sealed);
 if (blob.length < 34 || blob.length > MAX+65536) throw new Error("Invalid backup envelope");
 const packed = openSealed(PART_FORMAT,ring,blob);
 return validate(JSON.parse(gunzipSync(packed,{maxOutputLength:MAX}).toString("utf8")),true) as BackupPart;
}
export function openBackup(sealed: Uint8Array, keys: BackupKeys): BackupSnapshot {
 const ring = keysOf(keys);
 const blob = Buffer.from(sealed);
 if (blob.length < 34 || blob.length > MAX+65536) throw new Error("Invalid backup envelope");
 // Authenticate all ciphertext before decompression or parsing.
 const packed = openSealed(PART_FORMAT,ring,blob);
 return validate(JSON.parse(gunzipSync(packed,{maxOutputLength:MAX}).toString("utf8")));
}
export function restoreRows(snapshot: BackupSnapshot, now: number): BackupRow[] {
 const checked=validate(snapshot);
 if (!Number.isSafeInteger(now) || now < checked.capturedAt) throw new Error("Invalid restore clock");
 return checked.rows.filter(row=>row.expiresAt===null||row.expiresAt>now).map(row=>({...row}));
}
