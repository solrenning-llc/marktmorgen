/**
 * 273 [BK1] (inbox C1-20261108-2017-C4-36 item 7, C1-20261108-1941-C4-35 item 2): opens a backup set offline, with
 * Node's own modules only, so it runs without the GitHub repository, the site or any account: keep a copy of this one
 * file beside the owner's offline export.
 *
 *   node backup-restore-offline.mjs <folder> <manifest-id> [--out <file>]
 *
 * <folder> holds the set's objects as downloaded from the backup bucket, each named <id>.mmbk; <manifest-id> is the
 * manifest's id. The keys come on standard input, one base64 key per line (the current key, then the previous one
 * after a rotation), never on the command line, so they stay out of the shell's history; nothing prints a key.
 *
 * Without --out it only checks, in memory, and writes nothing anywhere: the manifest opens, every part is there with
 * the size and SHA-256 the manifest names, opens, and holds the manifest's rows; it prints the counts and the id of the
 * key that opened the set. That is the monthly check of a real set. With --out it also writes every row to that one
 * file (never over a file that is there), for a restore into a NEW, empty database (docs/backup.md). Anything wrong
 * stops it before a byte is written. The formats are those of lib/backup-codec.ts and lib/backup-parts.ts, written out
 * here again on purpose; tests/bk1-restore-offline.test.ts checks the two agree.
 */
import { createDecipheriv, createHash, createHmac } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { gunzipSync } from "node:zlib";

const ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const BASE64 = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;
const PART = { magicV1: "MMBK1", aadV1: "marktmorgen/backup/v1", magic: "MMBK2", aad: "marktmorgen/backup/v2" };
const MANIFEST = { magicV1: "MMBM1", aadV1: "marktmorgen/backup-manifest/v1", magic: "MMBM2", aad: "marktmorgen/backup-manifest/v2" };
const PART_JSON_MAX = 4 * 1024 * 1024;
const PART_MAX = PART_JSON_MAX + 65_536;
const MANIFEST_MAX = 10_000 * 160 + 65_536;

class Stop extends Error {}
const stop = (message) => {
  throw new Stop(message);
};

const kidOf = (key) => createHmac("sha256", key).update("mm-backup-kid").digest().subarray(0, 4);

function decrypt(key, aad, nonce, tag, body) {
  const decipher = createDecipheriv("aes-256-gcm", key, nonce);
  decipher.setAAD(aad);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(body), decipher.final()]);
}

/** The object's packed bytes and the key that opened it; authenticated before anything is read. */
function open(format, keys, blob) {
  const head = blob.subarray(0, 5).toString("latin1");
  if (head === format.magicV1 && blob.length >= 34) {
    for (const key of keys) {
      try {
        return { packed: decrypt(key, Buffer.from(format.aadV1), blob.subarray(5, 17), blob.subarray(17, 33), blob.subarray(33)), key };
      } catch {
        // The next key.
      }
    }
    return stop("an object does not open with any key given");
  }
  if (head !== format.magic || blob.length < 37) return stop("an object is not in a backup format");
  const kid = blob.subarray(5, 9);
  const key = keys.find((k) => kidOf(k).equals(kid));
  if (!key) return stop(`an object was sealed under key id ${kid.toString("hex")}, which no key given has`);
  try {
    return { packed: decrypt(key, Buffer.concat([Buffer.from(format.aad), kid]), blob.subarray(9, 21), blob.subarray(21, 37), blob.subarray(37)), key };
  } catch {
    return stop("an object does not authenticate");
  }
}

const json = (packed, max) => JSON.parse(gunzipSync(packed, { maxOutputLength: max }).toString("utf8"));
const whole = (n, least = 0) => Number.isSafeInteger(n) && n >= least;

function main() {
  const args = process.argv.slice(2);
  const outAt = args.indexOf("--out");
  const out = outAt === -1 ? null : args[outAt + 1];
  const positional = outAt === -1 ? args : [...args.slice(0, outAt), ...args.slice(outAt + 2)];
  if (positional.length !== 2 || (outAt !== -1 && !out)) stop("usage: node backup-restore-offline.mjs <folder> <manifest-id> [--out <file>], keys on standard input");
  const [folder, manifestId] = positional;
  if (!ID.test(manifestId)) stop("the manifest id is not one");
  if (out && existsSync(out)) stop("the output file is there already; it is never written over");

  const keys = readFileSync(0, "utf8").split(/\r?\n/).map((line) => line.trim()).filter(Boolean).map((line) => {
    const key = BASE64.test(line) ? Buffer.from(line, "base64") : Buffer.alloc(0);
    return key.length === 32 ? key : stop("a key on standard input is not 32 bytes of base64");
  });
  if (keys.length === 0) stop("no key on standard input");

  const read = (id, max) => {
    const path = join(folder, `${id}.mmbk`);
    if (!existsSync(path)) stop(`object ${id} is missing`);
    const blob = readFileSync(path);
    if (blob.length > max) stop(`object ${id} is larger than its format allows`);
    return blob;
  };

  const opened = open(MANIFEST, keys, read(manifestId, MANIFEST_MAX));
  const manifest = json(opened.packed, MANIFEST_MAX);
  if (!manifest || manifest.version !== 1 || !whole(manifest.capturedAt) || !Array.isArray(manifest.parts) || manifest.parts.length > 10_000 || !whole(manifest.rows)) stop("the manifest is not one");
  const ids = new Set();
  let total = 0;
  for (const part of manifest.parts) {
    if (!part || !ID.test(part.id) || ids.has(part.id) || !whole(part.rows) || !whole(part.bytes, 34) || part.bytes > PART_MAX || !/^[0-9a-f]{64}$/.test(part.sha256)) stop("the manifest names a part it cannot");
    ids.add(part.id);
    total += part.rows;
  }
  if (total !== manifest.rows) stop("the manifest's rows do not add up");

  const keysSeen = new Set();
  const rows = [];
  let bytes = 0;
  for (const part of manifest.parts) {
    const blob = read(part.id, PART_MAX);
    if (blob.length !== part.bytes || createHash("sha256").update(blob).digest("hex") !== part.sha256) stop(`part ${part.id} differs from its manifest`);
    const snapshot = json(open(PART, keys, blob).packed, PART_JSON_MAX);
    if (!snapshot || snapshot.version !== 1 || snapshot.capturedAt !== manifest.capturedAt || !Array.isArray(snapshot.rows) || snapshot.rows.length !== part.rows) stop(`part ${part.id} does not match its manifest`);
    for (const row of snapshot.rows) {
      // The repository reader's checks (lib/backup-codec.ts validate): a key of at most 1,024 bytes, and a dump in
      // canonical base64 only (Claude 2's LOW 2, 9 November 2026), so --out never writes a row it would refuse.
      const fine = row && typeof row.key === "string" && row.key.startsWith("nl:") && Buffer.byteLength(row.key) <= 1024 && !keysSeen.has(row.key)
        && typeof row.dump === "string" && row.dump.length > 0 && BASE64.test(row.dump) && Buffer.from(row.dump, "base64").toString("base64") === row.dump
        && (row.expiresAt === null || (whole(row.expiresAt) && row.expiresAt > manifest.capturedAt));
      if (!fine) stop(`part ${part.id} holds a row it cannot`);
      keysSeen.add(row.key);
      if (out) rows.push({ key: row.key, dump: row.dump, expiresAt: row.expiresAt });
    }
    bytes += blob.length;
  }
  if (out) writeFileSync(out, JSON.stringify({ version: 1, capturedAt: manifest.capturedAt, rows }), { flag: "wx", mode: 0o600 });
  process.stdout.write(`${JSON.stringify({ manifest: manifestId, capturedAt: manifest.capturedAt, parts: manifest.parts.length, rows: keysSeen.size, bytes, kid: kidOf(opened.key).toString("hex"), written: out ? true : false })}\n`);
}

try {
  main();
} catch (error) {
  process.stderr.write(`backup-restore-offline: ${error instanceof Stop ? error.message : "the set could not be read"}\n`);
  process.exitCode = 1;
}
