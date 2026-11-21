/**
 * 273 [BK1]: where a sealed backup is kept — a Cloudflare R2 bucket of its own,
 * never the sold files' (lib/vault.ts) — for lib/backup-roundtrip.ts, which
 * writes a backup once and reads it back before it counts. Off until the
 * owner creates that bucket and its own key and sets BACKUP_R2_ACCOUNT_ID,
 * BACKUP_R2_BUCKET, BACKUP_R2_ACCESS_KEY_ID and BACKUP_R2_SECRET_ACCESS_KEY
 * (and BACKUP_R2_JURISDICTION=eu for a bucket made under the EU jurisdiction)
 * (docs/backup.md); nothing here creates a bucket, a key or a setting, and
 * nothing calls it yet. The check against the sold files' bucket and key id
 * compares names only: the key itself must be one the owner scoped to the
 * backup bucket alone.
 *
 * Every write is create-only: PutObject with If-None-Match: *, which R2
 * evaluates atomically, so of two writes under one name at most one succeeds
 * and the other is answered 412 (https://developers.cloudflare.com/r2/api/s3/api/,
 * read 31 October 2026; a 412 is billed as a Class A operation,
 * https://developers.cloudflare.com/r2/pricing/). A read is held to its byte
 * cap as it streams.
 *
 * Retention (inbox C4-49): the daily run lists its own objects under backups/
 * (ListObjectsV2, a Class A operation each page, with each object's time and
 * size) and deletes, one by one with
 * DeleteObject (free on R2, https://developers.cloudflare.com/r2/pricing/, read
 * 4 November 2026 by Claude 1, inbox C4-38), the oldest when a set would not
 * fit under the review's ceiling and, after a write, those older than the
 * review's retention (lib/backup-run.ts). The listing offers only names this store
 * writes (backups/<uuid>.mmbk), so nothing else in the bucket is ever deleted;
 * a listing it cannot read whole throws, never reads as an empty bucket. The
 * bucket's lifecycle rule stays as a safety net.
 */
import { EMPTY_HASH, hashOf, signV4, type AwsKey } from "@/lib/aws-sign";
import { timed } from "@/lib/fetch-timeout";
import type { BackupBucket } from "@/lib/backup-roundtrip";

export type BackupStoreConfig = { endpoint: string; bucket: string; key: AwsKey };

const REGION = "auto";
const SERVICE = "s3";
const TIMEOUT_MS = 20_000;
/** The names verifyBackupRoundtrip gives: a random UUID. */
const ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
/** Where the backup's objects live in its bucket, and the name of one of them. */
const PREFIX = "backups/";
const OBJECT_NAME = /^backups\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.mmbk$/;
/** Names one listing page holds at the most (S3's own limit), and the most its answer may weigh. */
export const BACKUP_LIST_PAGE_KEYS = 1_000;
const LIST_MAX_BYTES = 1_048_576;

/** The owner's own backup bucket and key; null when any is missing or malformed, or is the sold files' bucket or key. */
export function backupStoreConfig(): BackupStoreConfig | null {
  const account = (process.env.BACKUP_R2_ACCOUNT_ID ?? "").trim();
  const bucket = (process.env.BACKUP_R2_BUCKET ?? "").trim();
  const accessKeyId = (process.env.BACKUP_R2_ACCESS_KEY_ID ?? "").trim();
  const secretAccessKey = (process.env.BACKUP_R2_SECRET_ACCESS_KEY ?? "").trim();
  if (!/^[0-9a-f]{32}$/.test(account) || accessKeyId.length < 16 || secretAccessKey.length < 32) return null;
  if (!/^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$/.test(bucket)) return null;
  // Never the sold files' bucket or key (docs/backup.md, owner prerequisites 2 and 3).
  if (bucket === (process.env.R2_BUCKET ?? "").trim() || accessKeyId === (process.env.R2_ACCESS_KEY_ID ?? "").trim()) return null;
  // A bucket made under the EU jurisdiction has an address of its own (https://developers.cloudflare.com/r2/reference/data-location/).
  const jurisdiction = (process.env.BACKUP_R2_JURISDICTION ?? "").trim().toLowerCase();
  if (jurisdiction !== "" && jurisdiction !== "eu") return null;
  const host = jurisdiction === "eu" ? `${account}.eu.r2.cloudflarestorage.com` : `${account}.r2.cloudflarestorage.com`;
  return { endpoint: `https://${host}`, bucket, key: { accessKeyId, secretAccessKey } };
}

const objectUrl = (config: BackupStoreConfig, id: string) => {
  if (!ID.test(id)) throw new Error("Invalid backup id");
  return `${config.endpoint}/${config.bucket}/backups/${id}.mmbk`;
};

/** A response's body, held to `maxBytes` as it streams; throws past it. */
async function bodyWithin(response: Response, maxBytes: number): Promise<Uint8Array> {
  if (!response.body) return new Uint8Array(0);
  if (Number(response.headers.get("content-length") ?? "0") > maxBytes) {
    await response.body.cancel().catch(() => {});
    throw new Error("Backup read exceeds bound");
  }
  const reader = response.body.getReader();
  const parts: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel().catch(() => {});
      throw new Error("Backup read exceeds bound");
    }
    parts.push(value);
  }
  const whole = new Uint8Array(total);
  let at = 0;
  for (const part of parts) {
    whole.set(part, at);
    at += part.byteLength;
  }
  return whole;
}

/** The text of one field that appears exactly once in a listing; null when it is missing or repeated. */
function single(xml: string, name: string): string | null {
  const openings = xml.match(new RegExp(`<(?:[A-Za-z_][A-Za-z0-9_.-]*:)?${name}[^A-Za-z0-9_.:-]`, "g")) ?? [];
  const fields = [...xml.matchAll(new RegExp(`<${name}>([^<]*)</${name}>`, "g"))];
  return openings.length === 1 && fields.length === 1 ? fields[0][1] : null;
}

/**
 * One listing page read whole, or a throw: the backup's own objects with their write times, and the token to go on.
 * A field missing, repeated or out of shape, a name listed twice, a count that does not match, or a truncated page
 * with no token throws.
 */
export function readListing(xml: string): { objects: { id: string; writtenAt: number; bytes: number }[]; next: string | null } {
  if (!xml.includes("<ListBucketResult") || !xml.includes("</ListBucketResult>")) throw new Error("Invalid backup listing");
  const truncated = single(xml, "IsTruncated");
  if (truncated !== "true" && truncated !== "false") throw new Error("Invalid backup listing");
  const entries = xml.match(/<Contents>[\s\S]*?<\/Contents>/g) ?? [];
  const opened = (xml.match(/<(?:[A-Za-z_][A-Za-z0-9_.-]*:)?Contents[^A-Za-z0-9_.:-]/g) ?? []).length;
  if (entries.length > BACKUP_LIST_PAGE_KEYS || opened !== entries.length) throw new Error("Invalid backup listing");
  if (/<(?:[A-Za-z_][A-Za-z0-9_.-]*:)?KeyCount[^A-Za-z0-9_.:-]/.test(xml) && single(xml, "KeyCount") !== String(entries.length)) throw new Error("Invalid backup listing");
  const objects: { id: string; writtenAt: number; bytes: number }[] = [];
  const names = new Set<string>();
  for (const entry of entries) {
    const name = single(entry, "Key");
    const when = single(entry, "LastModified");
    const writtenAt = when !== null && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/.test(when) ? Date.parse(when) : NaN;
    const size = single(entry, "Size");
    const bytes = size !== null && /^\d{1,15}$/.test(size) ? Number(size) : NaN;
    if (name === null || !name.startsWith(PREFIX) || !Number.isSafeInteger(writtenAt) || !Number.isSafeInteger(bytes)) throw new Error("Invalid backup listing entry");
    // A listing names each object once: one named twice would be counted twice and push the run to delete copies.
    if (names.has(name)) throw new Error("Invalid backup listing entry");
    names.add(name);
    // Only what this store writes is offered; any other name under the prefix is left alone.
    const id = OBJECT_NAME.exec(name)?.[1];
    if (id) objects.push({ id, writtenAt, bytes });
  }
  const token = truncated === "true" ? single(xml, "NextContinuationToken") : null;
  const next = token === null ? null : token.replace(/&(amp|lt|gt|quot|apos);/g, (_, e: string) => ({ amp: "&", lt: "<", gt: ">", quot: '"', apos: "'" })[e] as string);
  if (truncated === "true" && !next) throw new Error("Invalid backup listing");
  return { objects, next };
}

/** The store lib/backup-roundtrip.ts writes to and reads back from, and the run lists and prunes. Every failure throws: nothing is taken as written, read or deleted on doubt. */
export function r2BackupStore(config: BackupStoreConfig): BackupBucket {
  return {
    putNew: async (id, bytes) => {
      const url = objectUrl(config, id);
      const payloadHash = hashOf(bytes);
      const headers = signV4({
        method: "PUT",
        url,
        headers: { "content-type": "application/octet-stream", "if-none-match": "*", "x-amz-content-sha256": payloadHash },
        payloadHash,
        region: REGION,
        service: SERVICE,
        key: config.key,
      });
      const status = await timed(TIMEOUT_MS, async (signal) => {
        // A redirect is refused, never followed: a PUT turned into a GET elsewhere could answer 200.
        const response = await fetch(url, { method: "PUT", headers, body: bytes as BodyInit, signal, cache: "no-store", redirect: "error" });
        await response.body?.cancel().catch(() => {});
        return response.status;
      });
      if (status === 412) throw new Error("A backup with this id already exists");
      if (status !== 200) throw new Error(`Backup write failed with status ${status}`);
    },
    read: async (id, maxBytes) => {
      if (!Number.isSafeInteger(maxBytes) || maxBytes <= 0) throw new Error("Invalid backup read bound");
      const url = objectUrl(config, id);
      const headers = signV4({ method: "GET", url, headers: { "x-amz-content-sha256": EMPTY_HASH }, payloadHash: EMPTY_HASH, region: REGION, service: SERVICE, key: config.key });
      return timed(TIMEOUT_MS, async (signal) => {
        const response = await fetch(url, { headers: { ...headers, "accept-encoding": "identity" }, signal, cache: "no-store", redirect: "error" });
        if (response.status !== 200 || !response.body) {
          await response.body?.cancel().catch(() => {});
          throw new Error(`Backup read failed with status ${response.status}`);
        }
        return bodyWithin(response, maxBytes);
      });
    },
    list: async (next) => {
      const url = new URL(`${config.endpoint}/${config.bucket}`);
      url.searchParams.set("list-type", "2");
      url.searchParams.set("prefix", PREFIX);
      url.searchParams.set("max-keys", String(BACKUP_LIST_PAGE_KEYS));
      if (next !== null) {
        if (typeof next !== "string" || next.length === 0 || next.length > 1_024) throw new Error("Invalid backup listing token");
        url.searchParams.set("continuation-token", next);
      }
      const address = url.toString();
      const headers = signV4({ method: "GET", url: address, headers: { "x-amz-content-sha256": EMPTY_HASH }, payloadHash: EMPTY_HASH, region: REGION, service: SERVICE, key: config.key });
      const xml = await timed(TIMEOUT_MS, async (signal) => {
        const response = await fetch(address, { headers: { ...headers, "accept-encoding": "identity" }, signal, cache: "no-store", redirect: "error" });
        if (response.status !== 200) {
          await response.body?.cancel().catch(() => {});
          throw new Error(`Backup listing failed with status ${response.status}`);
        }
        return new TextDecoder("utf-8", { fatal: true }).decode(await bodyWithin(response, LIST_MAX_BYTES));
      });
      return readListing(xml);
    },
    delete: async (id) => {
      const url = objectUrl(config, id);
      const headers = signV4({ method: "DELETE", url, headers: { "x-amz-content-sha256": EMPTY_HASH }, payloadHash: EMPTY_HASH, region: REGION, service: SERVICE, key: config.key });
      const status = await timed(TIMEOUT_MS, async (signal) => {
        const response = await fetch(url, { method: "DELETE", headers, signal, cache: "no-store", redirect: "error" });
        await response.body?.cancel().catch(() => {});
        return response.status;
      });
      // S3 answers 204 for a delete, the object there or not; anything else is not taken as done.
      if (status !== 204 && status !== 200) throw new Error(`Backup delete failed with status ${status}`);
    },
  };
}
