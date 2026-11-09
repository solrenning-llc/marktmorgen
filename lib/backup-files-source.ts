/**
 * 273 [BK1], files part 1: what the backup files route does
 * (app/api/backup/files/route.ts): it lists one source of one store a page
 * at a time and signs a short-lived read URL for each object it lists.
 * Nothing else. It never reads, writes or deletes a file's bytes, so the bytes
 * go from the origin straight to the backup Worker, never through Vercel
 * (docs/backup-costs-2026-11-08.md, section 5.1; C1-20261108-2031-C4-38).
 *
 * Off, each checked before any provider is asked or any command is sent:
 *   - no route secret (BACKUP_FILES_ROUTE_SECRET, at least 32 characters, and
 *     never the same as another secret of the site): 404;
 *   - no review of the route's cost (lib/backup-files-review.ts, null until
 *     the owner approves it): 404, even with the secret;
 *   - R2 while its own read-only key is not set (lib/backup-files-r2.ts
 *     backupFilesR2Config: unset, malformed, or the site's read-write key):
 *     503 "source_off", "r2_read_key_unset", before any count;
 *   - Bunny Stream, always: 503 "source_off",
 *     "bunny_zone_and_original_unconfirmed" (below).
 *
 * R2's listing carries each object's ETag: Cloudflare's own R2 examples show
 * the ListObjectsV2 answer with `"ETag": "\"eb2b891dc67b81755d2b726d9110af16\""`
 * on each entry (developers.cloudflare.com/r2/examples/aws/aws-cli/, "Last
 * updated Oct 15, 2026"; .../aws-sdk-js-v3/, "Last updated Oct 26, 2026";
 * both read 2026-11-09), and the S3 API compatibility page marks
 * ListObjectsV2 implemented ("Last updated Oct 14, 2026"). An entry without
 * one still fails the listing (lib/backup-files-r2.ts), never passes.
 *
 * Bunny Stream, read on bunny.net/docs 2026-11-09 (its pages carry no
 * last-updated stamp; the Stream API's OpenAPI is version 1.6.21):
 *   - confirmed: a file is signed with the pull zone's own "URL Token
 *     Authentication Key", Basic (MD5, deprecated) or Advanced (HMAC-SHA256),
 *     both accepted on one zone (cdn/security/token-authentication), never
 *     with the library's API key, which can delete; the original is at
 *     https://{pull_zone}.b-cdn.net/{video_id}/original
 *     (stream/storage-structure); each video says `hasOriginal` and
 *     `originalHash` ("Original uploaded file SHA256 hash"), which can stand
 *     for its etag (api-reference/stream/manage-videos/get-video);
 *   - NOT confirmed, so it stays off: the library's pull zone host and its
 *     URL token key (neither is a setting of this site: BUNNY_STREAM_TOKEN_KEY
 *     is the player's embed key, and no page says it is the zone's); whether the owner's
 *     library keeps originals, which must be on BEFORE a video is uploaded
 *     (stream/encoding, "Keep original files"), and lib/stream.ts's record of
 *     its setup does not say; and the original's byte size, which a video's
 *     listing does not carry (`storageSize` is every file of the video): only
 *     a call per video to its storage info (`originals`) gives it, a cost no
 *     review covers.
 *
 * Who holds what: the Worker holds the route's secret and nothing else of
 * production. A stolen secret lists names and reads files for minutes; it can
 * never write or delete, because the route only lists and signs `get`.
 *
 * Vercel Blob (vercel-signed-urls page, `last_updated: 2026-09-15`, reread
 * 2026-11-08 22:55 UTC): ONE `issueSignedToken({ operations: ["get"],
 * pathname: "*", validUntil })` a call, made only when there is something to
 * sign, then `presignUrl` for each object, which is HMAC-only (no network
 * call). The token's clientSigningToken never leaves this file.
 *
 * Bounds:
 *   - at most BACKUP_FILES_PAGE_ENTRIES entries and BACKUP_FILES_PAGE_BYTES a
 *     page; signing stops at the internal cutoff (BACKUP_FILES_CUTOFF_MS) and
 *     the page so far is answered incomplete with a cursor that resumes after
 *     the last entry signed, losing none;
 *   - at most BACKUP_FILES_PAGES_PER_STORE provider pages a listing: a store
 *     with more objects is answered "over_bound", never complete (item 8);
 *   - at most the review's maxPagesPerDay pages a UTC day for each source,
 *     counted before the provider is asked (one SET NX EX and one INCRBY, read
 *     in their exact shape, rule 24): past it 429, unreadable 503.
 *
 *   nl:backup:files:day:<YYYY-MM-DD>:<source>   the day's pages of one source (or of the stores or
 *                                               deletions page), kept two days
 *
 * Rule 24: a listing or a token that cannot be read in its exact shape throws,
 * and the route answers 503: never an empty or complete page.
 */
import { createHash, timingSafeEqual } from "node:crypto";
import * as blob from "@/lib/blob";
import {
  BACKUP_FILES_PAGE_BYTES,
  BACKUP_FILES_PAGE_ENTRIES,
  BACKUP_FILES_PAGES_PER_STORE,
  BACKUP_FILES_URL_SECONDS,
  type BackupFilesEntry,
  type BackupFilesPage,
  type BackupFilesReason,
  type BackupFilesSource,
  parseFilesPage,
  sourcePrefix,
} from "@/lib/backup-files-contract";
import { backupFilesR2Config, listR2Page, presignR2Get } from "@/lib/backup-files-r2";
import type { BackupFilesRouteReview } from "@/lib/backup-files-review";
import { redisPipeline } from "@/lib/redis";

/** The shortest route secret taken as set. */
export const BACKUP_FILES_SECRET_MIN = 32;
/** When signing stops inside a call, from its start: the rest goes on the next page. */
export const BACKUP_FILES_CUTOFF_MS = 8_000;
/** The hard end of a call, from its start, for every request inside it (lib/fetch-timeout.ts withCutoff), inside the route's 10 s. */
export const BACKUP_FILES_REQUEST_MS = 9_000;

/** Why a source is never listed, or null when it may be. Changing one needs its provider detail confirmed from an official page first. */
const SOURCE_OFF: Record<BackupFilesSource, string | null> = {
  blob: null,
  r2: null,
  bunny: "bunny_zone_and_original_unconfirmed",
};

/** Why a source is not listed now, or null when it is: never-listed sources, and R2 while its own read-only key is not set. */
export function backupFilesSourceOff(source: BackupFilesSource, env: Record<string, string | undefined> = process.env): string | null {
  if (SOURCE_OFF[source]) return SOURCE_OFF[source];
  if (source === "r2" && !backupFilesR2Config(env)) return "r2_read_key_unset";
  return null;
}

/** Settings the route's secret may never equal: one secret stolen must never be another. */
const OTHER_SECRETS = [
  "CRON_SECRET",
  "BLOB_READ_WRITE_TOKEN",
  "R2_ACCESS_KEY_ID",
  "R2_SECRET_ACCESS_KEY",
  "BACKUP_FILES_R2_READ_SECRET",
  "BUNNY_STREAM_API_KEY",
  "BUNNY_STREAM_TOKEN_KEY",
  "BUNNY_STREAM_READ_KEY",
  "BACKUP_ENCRYPTION_KEY",
];

/** The route's own secret, or null when it is unset, short, or the same as another secret of the site. */
export function backupFilesRouteSecret(env: Record<string, string | undefined> = process.env): string | null {
  const secret = (env.BACKUP_FILES_ROUTE_SECRET ?? "").trim();
  if (secret.length < BACKUP_FILES_SECRET_MIN) return null;
  if (OTHER_SECRETS.some((name) => (env[name] ?? "").trim() === secret)) return null;
  return secret;
}

const digest = (text: string) => createHash("sha256").update(text, "utf8").digest();

/** Whether an Authorization header is exactly "Bearer <secret>", compared in constant time. */
export function secretMatches(header: string | null, secret: string): boolean {
  const given = typeof header === "string" && header.startsWith("Bearer ") ? header.slice("Bearer ".length) : "";
  // Both sides hashed first: equal lengths, so the comparison takes the same time whatever was sent.
  return timingSafeEqual(digest(given), digest(secret)) && given.length > 0;
}

/** The review read once from its own data fields (never a getter), or null: no review, the route stays off. */
export function admitFilesReview(raw: unknown): BackupFilesRouteReview | null {
  if (!raw || typeof raw !== "object" || Object.getPrototypeOf(raw) !== Object.prototype) return null;
  const read = (name: string): unknown => {
    const descriptor = Object.getOwnPropertyDescriptor(raw, name);
    return descriptor && "value" in descriptor ? descriptor.value : undefined;
  };
  const maxPagesPerDay = read("maxPagesPerDay");
  const reviewedAt = read("reviewedAt");
  const source = read("source");
  if (typeof maxPagesPerDay !== "number" || !Number.isSafeInteger(maxPagesPerDay) || maxPagesPerDay < 1 || maxPagesPerDay > 1_000_000) return null;
  if (typeof reviewedAt !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(reviewedAt) || typeof source !== "string" || source.trim().length < 3) return null;
  return { maxPagesPerDay, reviewedAt, source };
}

// -------------------------------------------------------------------- cursor

type CursorState = { page: number; provider: string | null; after: string | null };

/** Where the next page starts: the provider page (its index and its own cursor) and the last key signed in it, if any. */
export function encodeFilesCursor(source: BackupFilesSource, store: string, state: CursorState): string {
  return Buffer.from(JSON.stringify({ v: 1, s: source, st: store, p: state.page, c: state.provider, a: state.after }), "utf8").toString("base64url");
}

const CONTROL = /[\u0000-\u001f\u007f]/;

/** A cursor this route made for this source and store, or null for anything else. */
export function decodeFilesCursor(text: string, source: BackupFilesSource, store: string): CursorState | null {
  if (!/^[A-Za-z0-9_-]{1,4096}$/.test(text)) return null;
  let value: unknown;
  try {
    value = JSON.parse(Buffer.from(text, "base64url").toString("utf8"));
  } catch {
    return null;
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const { v, s, st, p, c, a, ...rest } = value as Record<string, unknown>;
  if (Object.keys(rest).length || v !== 1 || s !== source || st !== store) return null;
  if (typeof p !== "number" || !Number.isSafeInteger(p) || p < 0 || p >= BACKUP_FILES_PAGES_PER_STORE) return null;
  const text1 = (x: unknown, most: number) => x === null || (typeof x === "string" && x.length > 0 && x.length <= most && !CONTROL.test(x));
  if (!text1(c, 2048) || !text1(a, 1024)) return null;
  if (p > 0 && c === null) return null;
  return { page: p, provider: c as string | null, after: a as string | null };
}

// ------------------------------------------------------------- day's ceiling

/** What the day's reviewed pages are counted for: each source's listing, and the stores and deletions pages. */
export type BackupFilesPageKind = BackupFilesSource | "stores" | "deletions";

/** Takes one of the day's reviewed pages for a source (or page) before the provider or the database is asked: "ok", "over" past it, "unknown" when the count cannot be read. */
export async function takeDayPage(source: BackupFilesPageKind, review: BackupFilesRouteReview, now = Date.now()): Promise<"ok" | "over" | "unknown"> {
  const key = `nl:backup:files:day:${new Date(now).toISOString().slice(0, 10)}:${source}`;
  try {
    // Exactly two replies: the SET's "OK" or null, and the INCRBY's own integer. Anything else is unknown (rule 24).
    const reply: unknown = await redisPipeline([["SET", key, "0", "NX", "EX", 2 * 86_400], ["INCRBY", key, 1]]);
    const count = Array.isArray(reply) && reply.length === 2 && (reply[0] === null || reply[0] === "OK") ? reply[1] : undefined;
    if (typeof count !== "number" || !Number.isSafeInteger(count) || count < 1) return "unknown";
    return count > review.maxPagesPerDay ? "over" : "ok";
  } catch {
    return "unknown";
  }
}

// ------------------------------------------------------------------- listing

type Listed = { objects: { key: string; etag: string; size: number }[]; next: string | null };

class SourceError extends Error {
  constructor(message: string) {
    super(`backup files source: ${message}`);
    this.name = "BackupFilesSourceError";
  }
}
const fail = (message: string): never => {
  throw new SourceError(message);
};

/** One page of Vercel Blob under `prefix`, read in its exact shape; throws on anything else. */
async function listBlob(prefix: string, cursor: string | null): Promise<Listed> {
  const answer: unknown = await blob.list({ prefix, limit: BACKUP_FILES_PAGE_ENTRIES, cursor: cursor ?? undefined });
  if (!answer || typeof answer !== "object") fail("the listing is not an object");
  const { blobs, hasMore, cursor: next } = answer as { blobs?: unknown; hasMore?: unknown; cursor?: unknown };
  if (!Array.isArray(blobs) || blobs.length > BACKUP_FILES_PAGE_ENTRIES || typeof hasMore !== "boolean") fail("the listing has no list of at most 1,000 or no hasMore");
  if (hasMore && (typeof next !== "string" || next.length === 0 || next.length > 2048)) fail("more is said to follow, with no cursor");
  const seen = new Set<string>();
  const objects = (blobs as unknown[]).map((item) => {
    const { pathname, size, etag } = (item ?? {}) as { pathname?: unknown; size?: unknown; etag?: unknown };
    if (typeof pathname !== "string" || !pathname.startsWith(prefix) || pathname.length === prefix.length || pathname.length > 1024 || seen.has(pathname)) fail("an entry outside the folder, or twice");
    seen.add(pathname as string);
    if (typeof size !== "number" || !Number.isSafeInteger(size) || size < 0) fail("a size that is not a count");
    if (typeof etag !== "string" || !/^[\x21-\x7e]{1,256}$/.test(etag)) fail("an entry without its etag");
    return { key: pathname as string, etag: etag as string, size: size as number };
  });
  return { objects, next: hasMore ? (next as string) : null };
}

type Signer = (key: string) => Promise<{ url: string; expiresAt: number }>;

/** Blob's signer: one get-only token for "*" made on the first object to sign, then a local signature each. */
function blobSigner(now: () => number): Signer {
  let token: { delegationToken: string; clientSigningToken: string; validUntil: number } | null = null;
  return async (key) => {
    if (!token) {
      const asked = now() + BACKUP_FILES_URL_SECONDS * 1000;
      const issued: unknown = await blob.issueSignedToken({ operations: ["get"], pathname: "*", validUntil: asked });
      const { delegationToken, clientSigningToken, validUntil } = (issued ?? {}) as Record<string, unknown>;
      if (typeof delegationToken !== "string" || !delegationToken || typeof clientSigningToken !== "string" || !clientSigningToken) fail("a token without its parts");
      if (typeof validUntil !== "number" || !Number.isSafeInteger(validUntil) || validUntil < now() + 60_000) fail("a token that runs out within a minute");
      token = { delegationToken: delegationToken as string, clientSigningToken: clientSigningToken as string, validUntil: Math.min(validUntil as number, asked) };
    }
    const held = token;
    const signed: unknown = await blob.presignUrl({ delegationToken: held.delegationToken, clientSigningToken: held.clientSigningToken }, { operation: "get", pathname: key, access: "private", validUntil: held.validUntil });
    const url = (signed as { presignedUrl?: unknown } | null)?.presignedUrl;
    if (typeof url !== "string" || !url.startsWith("https://") || url.includes(held.clientSigningToken)) fail("a signed URL it cannot hand out");
    return { url: url as string, expiresAt: held.validUntil };
  };
}

function sourceOf(source: BackupFilesSource, now: () => number): { list: (prefix: string, cursor: string | null) => Promise<Listed>; sign: Signer } {
  const off = backupFilesSourceOff(source);
  if (off) fail(`${source} is off (${off})`);
  if (source === "blob") return { list: listBlob, sign: blobSigner(now) };
  const config = backupFilesR2Config();
  if (source !== "r2" || !config) return fail(`${source} is not set up`);
  return {
    list: (prefix, cursor) => listR2Page(config, prefix, cursor),
    sign: async (key) => {
      const at = now();
      return { url: presignR2Get(config, key, BACKUP_FILES_URL_SECONDS, new Date(at)), expiresAt: Math.floor(at / 1000) * 1000 + BACKUP_FILES_URL_SECONDS * 1000 };
    },
  };
}

/** Room kept in a page's 1 MB for its own fields and its cursor. */
const PAGE_HEAD_BYTES = 8_192;

/**
 * One page of one source of one store, from `cursor` (null for the first):
 * at most one provider page, its objects signed until the cutoff or the
 * page's bytes run out. Throws when the provider cannot be read in its exact
 * shape; the page it returns has passed parseFilesPage.
 */
export async function backupFilesPage(
  input: { source: BackupFilesSource; store: string; cursor: string | null },
  options: { stopAt: number; now?: () => number },
): Promise<BackupFilesPage> {
  const now = options.now ?? Date.now;
  const prefix = sourcePrefix(input.source, input.store);
  if (prefix === null) return fail(`no listing of ${input.source} is built`);
  const state = input.cursor === null ? { page: 0, provider: null, after: null } : decodeFilesCursor(input.cursor, input.source, input.store);
  if (!state) return fail("a cursor this route did not make");
  const source = sourceOf(input.source, now);
  const answer = (entries: BackupFilesEntry[], reason: BackupFilesReason, next: CursorState | null) =>
    parseFilesPage({
      version: 1,
      kind: "files",
      source: input.source,
      store: input.store,
      entries,
      cursor: next ? encodeFilesCursor(input.source, input.store, next) : null,
      complete: reason === "done",
      reason,
    });

  if (now() >= options.stopAt) return answer([], "cutoff", state);
  const listed = await source.list(prefix, state.provider);
  let objects = listed.objects;
  if (state.after !== null) {
    // Resume after the last entry signed. If the provider page changed and it is gone, the whole page again:
    // an entry twice is harmless to the Worker (same key and etag), one lost is not.
    const at = objects.findIndex((object) => object.key === state.after);
    if (at >= 0) objects = objects.slice(at + 1);
  }
  const entries: BackupFilesEntry[] = [];
  let bytes = PAGE_HEAD_BYTES;
  for (const object of objects) {
    const resume = { page: state.page, provider: state.provider, after: entries.length ? entries[entries.length - 1].key : state.after };
    if (now() >= options.stopAt) return answer(entries, "cutoff", resume);
    const signed = await source.sign(object.key);
    const entry: BackupFilesEntry = { source: input.source, key: object.key, etag: object.etag, size: object.size, url: signed.url, expiresAt: signed.expiresAt };
    const weight = Buffer.byteLength(JSON.stringify(entry), "utf8") + 1;
    if (bytes + weight > BACKUP_FILES_PAGE_BYTES) return answer(entries, "page_bytes", resume);
    bytes += weight;
    entries.push(entry);
  }
  if (listed.next === null) return answer(entries, "done", null);
  if (state.page + 1 >= BACKUP_FILES_PAGES_PER_STORE) return answer(entries, "over_bound", null);
  return answer(entries, "more", { page: state.page + 1, provider: listed.next, after: null });
}
