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
 * cap as it streams. There is no delete here: retention is a later unit, with
 * its own reviewed key.
 */
import { EMPTY_HASH, hashOf, signV4, type AwsKey } from "@/lib/aws-sign";
import { timed } from "@/lib/fetch-timeout";
import type { BackupObjectStore } from "@/lib/backup-roundtrip";

export type BackupStoreConfig = { endpoint: string; bucket: string; key: AwsKey };

const REGION = "auto";
const SERVICE = "s3";
const TIMEOUT_MS = 20_000;
/** The names verifyBackupRoundtrip gives: a random UUID. */
const ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

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

/** The store lib/backup-roundtrip.ts writes to and reads back from. Every failure throws: nothing is taken as written or read on doubt. */
export function r2BackupStore(config: BackupStoreConfig): BackupObjectStore {
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
      });
    },
  };
}
