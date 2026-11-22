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
 *   - a key that cannot be signed as itself, or that breaks the contract's own
 *     key rule (a C0 control, DEL, over 1,024 characters), is left out alone and
 *     its listing ends "unsignable", never complete (Claude 5's and Claude 3's
 *     MEDIUMs on #3313);
 *   - at most the review's maxPagesPerDay pages a UTC day for each source
 *     (and its own maxStoresPagesPerDay and maxDeletionsPagesPerDay for those pages),
 *     counted before the provider is asked (one INCR and one EXPIRE NX, lib/window-count.ts, read
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
  BACKUP_FILES_DAY_CEILING_REFUSALS,
  type BackupFilesEntry,
  type BackupFilesPage,
  type BackupFilesReason,
  type BackupFilesSource,
  isContractKey,
  isContractUrl,
  parseFilesPage,
  sourcePrefix,
} from "@/lib/backup-files-contract";
import { R2UnsignableKey, backupFilesR2Config, listR2Page, presignR2Get } from "@/lib/backup-files-r2";
import type { BackupFilesRouteReview } from "@/lib/backup-files-review";
import { redisPipeline } from "@/lib/redis";
import { windowCount, windowCountOf } from "@/lib/window-count";

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

/** The route's maxDuration (app/api/backup/files/route.ts), the longest an admitted page can hold the function. */
export const BACKUP_FILES_ROUTE_SECONDS = 10;

/**
 * What one admitted page can cost, in whole micro-dollars, at the dearest prices read in docs/backup-costs-2026-11-08.md
 * section 2, no free quota (Claude 7's MÉDIO on #3313), the same parts as the route's ceiling per call of section 5b
 * ($0.00154736): the function call ($0.60 a million), held the whole
 * BACKUP_FILES_ROUTE_SECONDS at 2 GB with every second on CPU in the dearest region (gru1: $0.221 a CPU-hour, $0.0183 a
 * GB-hour); its answer at BACKUP_FILES_PAGE_BYTES as Fast Origin Transfer and Fast Data Transfer ($0.43 + $0.35 a GB)
 * and one CDN Request ($3.20 a million); the day's count, two Upstash commands ($2.00 a million) and a page of Upstash
 * bandwidth ($0.03 a GB); one listing and one Blob
 * signing token, each as a Blob Advanced Operation ($7.00 a million), the dearer of the two sources on (an R2
 * ListObjectsV2 is a $4.50 Class A, and R2 signs locally).
 */
export const BACKUP_FILES_PAGE_MICRO_USD = Math.ceil(
  0.6 +
    (221_000 * BACKUP_FILES_ROUTE_SECONDS) / 3600 +
    (18_300 * 2 * BACKUP_FILES_ROUTE_SECONDS) / 3600 +
    // The answer as Fast Origin Transfer and Fast Data Transfer at the top of their ranges, and its CDN Request.
    (BACKUP_FILES_PAGE_BYTES / 1e9) * (430_000 + 350_000) +
    3.2 +
    // The count's two Upstash commands, and up to a page of Upstash bandwidth (the deletion records' page).
    2 * 2 +
    (BACKUP_FILES_PAGE_BYTES / 1e9) * 30_000 +
    7 +
    7,
);
/** R2 bills operations in blocks of a million, rounded up: one more block a month for the source that lists on R2. */
const R2_BLOCK_MICRO_USD = 4_500_000;
/** UTC days a billing month can touch (as lib/backup-cost.ts BACKUP_DAYS_PER_MONTH). */
const ROUTE_DAYS_PER_MONTH = 32;
/** Room over the priced month, as the backup's other lines carry (docs/backup-costs-2026-11-08.md). */
const ROOM = 1.1;

/**
 * The route's worst month in micro-dollars, a company cost (the company's backup, 100% Marktmorgen under FX275): the
 * review's maxPagesPerDay, which takeDayPage counts before any provider call, and the day's one refused call past it
 * (BACKUP_FILES_DAY_CEILING_REFUSALS), for each source that is on, every UTC day of the month, plus R2's rounding block,
 * with room. No review: 0, since the route answers 404 before any command.
 * Null (unknown, never zero) for a review that is not a whole page count, or when Bunny Stream, whose listing price is
 * not read, is turned on.
 */
export function backupFilesRouteWorstMonth(review: BackupFilesRouteReview | null): number | null {
  if (review === null) return 0;
  if (!Number.isSafeInteger(review.maxPagesPerDay) || review.maxPagesPerDay < 1) return null;
  if (SOURCE_OFF.bunny === null) return null;
  const on = (["blob", "r2"] as const).filter((source) => SOURCE_OFF[source] === null).length;
  // And the day's refused call past the ceiling (BACKUP_FILES_DAY_CEILING_REFUSALS), priced as a whole page.
  const pages = on * (review.maxPagesPerDay + BACKUP_FILES_DAY_CEILING_REFUSALS) * ROUTE_DAYS_PER_MONTH;
  return Math.ceil((pages * BACKUP_FILES_PAGE_MICRO_USD + (SOURCE_OFF.r2 === null ? R2_BLOCK_MICRO_USD : 0)) * ROOM);
}

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

/**
 * The route's own secret, or null when it is unset, short, or the same as another setting of the site: the named
 * secrets above, and any other setting at all (Claude 2's LOW 2 and Codex Z's LOW 1, 9 November 2026: the files
 * bucket's read key id, printed in every R2 address, the backup bucket's key, the database's and Stripe's tokens were
 * taken), so the route's secret is never a value something else holds or prints.
 */
export function backupFilesRouteSecret(env: Record<string, string | undefined> = process.env): string | null {
  const secret = (env.BACKUP_FILES_ROUTE_SECRET ?? "").trim();
  if (secret.length < BACKUP_FILES_SECRET_MIN) return null;
  if (OTHER_SECRETS.some((name) => (env[name] ?? "").trim() === secret)) return null;
  if (Object.entries(env).some(([name, value]) => name !== "BACKUP_FILES_ROUTE_SECRET" && (value ?? "").trim() === secret)) return null;
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
  const figure = (name: string): number | null => {
    const value = read(name);
    return typeof value === "number" && Number.isSafeInteger(value) && value >= 1 && value <= 1_000_000 ? value : null;
  };
  // Each page kind's own figure (a review sized for listings never admits stores pages at that count): one missing is no review.
  const maxPagesPerDay = figure("maxPagesPerDay");
  const maxStoresPagesPerDay = figure("maxStoresPagesPerDay");
  const maxDeletionsPagesPerDay = figure("maxDeletionsPagesPerDay");
  const reviewedAt = read("reviewedAt");
  const source = read("source");
  if (maxPagesPerDay === null || maxStoresPagesPerDay === null || maxDeletionsPagesPerDay === null) return null;
  if (typeof reviewedAt !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(reviewedAt) || typeof source !== "string" || source.trim().length < 3) return null;
  return { maxPagesPerDay, maxStoresPagesPerDay, maxDeletionsPagesPerDay, reviewedAt, source };
}

// -------------------------------------------------------------------- cursor

/** `refused`: a key of this listing, on an earlier page or call, could not be signed and was left out (Claude 5's MEDIUM on #3313). */
type CursorState = { page: number; provider: string | null; after: string | null; refused?: true };

/** Where the next page starts: the provider page (its index and its own cursor) and the last key signed in it, if any. */
export function encodeFilesCursor(source: BackupFilesSource, store: string, state: CursorState): string {
  return Buffer.from(JSON.stringify({ v: 1, s: source, st: store, p: state.page, c: state.provider, a: state.after, ...(state.refused ? { r: 1 } : {}) }), "utf8").toString("base64url");
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
  const { v, s, st, p, c, a, r, ...rest } = value as Record<string, unknown>;
  if (Object.keys(rest).length || v !== 1 || s !== source || st !== store) return null;
  if (r !== undefined && r !== 1) return null;
  if (typeof p !== "number" || !Number.isSafeInteger(p) || p < 0 || p >= BACKUP_FILES_PAGES_PER_STORE) return null;
  const text1 = (x: unknown, most: number) => x === null || (typeof x === "string" && x.length > 0 && x.length <= most && !CONTROL.test(x));
  if (!text1(c, 2048) || !text1(a, 1024)) return null;
  if (p > 0 && c === null) return null;
  return { page: p, provider: c as string | null, after: a as string | null, ...(r === 1 ? { refused: true as const } : {}) };
}

// ------------------------------------------------------------- day's ceiling

/** What the day's reviewed pages are counted for: each source's listing, and the stores and deletions pages. */
export type BackupFilesPageKind = BackupFilesSource | "stores" | "deletions";

/** Takes one of the day's reviewed pages for a source (or page), against that kind's own figure of the review, before the provider or the database is asked: "ok", "over" past it, "unknown" when the count cannot be read. */
export async function takeDayPage(source: BackupFilesPageKind, review: BackupFilesRouteReview, now = Date.now()): Promise<"ok" | "over" | "unknown"> {
  const key = `nl:backup:files:day:${new Date(now).toISOString().slice(0, 10)}:${source}`;
  try {
    // The window count (lib/window-count.ts): INCR, then the expiry only when the key has none, so a key that expired
    // between two commands can never come back without one and hold the day's ceiling for good (Claude 2's MEDIUM on
    // #3313). Read only in its exact shape (windowCountOf, rule 24): anything else is unknown.
    const count = windowCountOf(await redisPipeline(windowCount(key, 2 * 86_400)));
    if (count === null) return "unknown";
    const ceiling = source === "stores" ? review.maxStoresPagesPerDay : source === "deletions" ? review.maxDeletionsPagesPerDay : review.maxPagesPerDay;
    return count > ceiling ? "over" : "ok";
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

/** A key whose signed address would not lead to it (leadsTo): that one object is left out of the page, never the page. */
class UnsignableKey extends SourceError {
  constructor() {
    super("a signed URL whose address is not the key's");
    this.name = "BackupFilesUnsignableKey";
  }
}

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
    // A name over 1,024 characters is still an entry of the folder: the page refuses it alone (isContractKey, below).
    if (typeof pathname !== "string" || !pathname.startsWith(prefix) || pathname.length === prefix.length || seen.has(pathname)) fail("an entry outside the folder, or twice");
    seen.add(pathname as string);
    if (typeof size !== "number" || !Number.isSafeInteger(size) || size < 0) fail("a size that is not a count");
    if (typeof etag !== "string" || !/^[\x21-\x7e]{1,256}$/.test(etag)) fail("an entry without its etag");
    return { key: pathname as string, etag: etag as string, size: size as number };
  });
  return { objects, next: hasMore ? (next as string) : null };
}

type Signer = (key: string) => Promise<{ url: string; expiresAt: number }>;

/** Whether a signed address requests exactly `/${key}`: its path, each part decoded, is the key, with no fragment. */
function leadsTo(address: string, key: string): boolean {
  try {
    const url = new URL(address);
    if (url.hash !== "" || address.includes("#")) return false;
    const decoded = url.pathname.split("/").map((piece) => decodeURIComponent(piece)).join("/");
    return decoded === `/${key}`;
  } catch {
    return false;
  }
}

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
    // Blob signs the raw pathname and puts it into the address as it is (@vercel/blob 2.8.0, constructBlobUrl): a key
    // with "?", "#" or an encoded part gives an address whose request path is not the signed one. As R2's signer
    // checks (lib/backup-files-r2.ts), the address must decode back to exactly this key, with no fragment, or the page
    // is not answered, never handed out as signed (Claude 7's LEVE on #3313).
    // That one key is left out, and its listing is never called complete (backupFilesPage, Claude 5's MEDIUM on #3313).
    if (!leadsTo(url as string, key)) throw new UnsignableKey();
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
      let url: string;
      try {
        url = presignR2Get(config, key, BACKUP_FILES_URL_SECONDS, new Date(at));
      } catch (error) {
        // A key R2's signer would not lead to (a dot segment, or an address that does not decode back to it) is that
        // one object left out, as a Blob key is, never the page (Codex N1's LOW 3 on #3313).
        if (error instanceof R2UnsignableKey) throw new UnsignableKey();
        throw error;
      }
      return { url, expiresAt: Math.floor(at / 1000) * 1000 + BACKUP_FILES_URL_SECONDS * 1000 };
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
  // A key that cannot be signed as itself ("%" or "#" kept in a Blob name: Claude 5's MEDIUM on #3313) is left out,
  // never handed out, and never takes the other entries down with it; the listing carries it in its cursor, so its
  // end is "unsignable", never complete, and the Worker alarms and applies no orphan end.
  let refused = state.refused === true;
  const carry = (next: CursorState): CursorState => (refused ? { ...next, refused: true } : next);
  const refuse = () => {
    if (!refused) console.error("backup files: a key could not be handed out as itself and is left out", input.source);
    refused = true;
  };
  // The last object looked at, handed out or left out: a page cut off goes on after it. Left out is carried in the
  // cursor (refused), so its end is still "unsignable". A key the contract refuses (a control or past 1,024
  // characters) is never the resume point, since the cursor refuses it too (Claude 6's MEDIUM on #4840): it is
  // passed without a cutoff until a key the cursor can carry is looked at, and looked at again after a cutoff, harmless.
  let looked = state.after;
  for (const object of objects) {
    const resume = carry({ page: state.page, provider: state.provider, after: looked });
    // The cutoff is kept only once this call has looked at one object: a listing slow enough to pass it would
    // otherwise answer an empty page with the cursor it was given, and a Worker repeating it would never move
    // (Codex N1's LOW 2 on #3313). A call that runs past the request's own limit (BACKUP_FILES_REQUEST_MS) still ends
    // there, unanswered, and its page is counted.
    if (looked !== state.after && now() >= options.stopAt) return answer(entries, "cutoff", resume);
    // The contract's own key rule first (a C0 control, DEL, or more than 1,024 characters: Claude 3's MEDIUM on
    // #3313): such a key would make parseFilesPage refuse the whole page, so it is left out alone, as below.
    if (!isContractKey(object.key)) {
      refuse();
      continue;
    }
    let signed: { url: string; expiresAt: number };
    try {
      signed = await source.sign(object.key);
    } catch (error) {
      if (!(error instanceof UnsignableKey)) throw error;
      refuse();
      looked = object.key;
      continue;
    }
    // The contract's own address rule too (Claude 3's second MEDIUM on #3313): an address past it would make
    // parseFilesPage refuse the whole page, so its key is left out alone, as above.
    if (!isContractUrl(signed.url)) {
      refuse();
      looked = object.key;
      continue;
    }
    const entry: BackupFilesEntry = { source: input.source, key: object.key, etag: object.etag, size: object.size, url: signed.url, expiresAt: signed.expiresAt };
    const weight = Buffer.byteLength(JSON.stringify(entry), "utf8") + 1;
    if (bytes + weight > BACKUP_FILES_PAGE_BYTES) return answer(entries, "page_bytes", resume);
    bytes += weight;
    entries.push(entry);
    looked = object.key;
  }
  if (listed.next === null) return answer(entries, refused ? "unsignable" : "done", null);
  if (state.page + 1 >= BACKUP_FILES_PAGES_PER_STORE) return answer(entries, "over_bound", null);
  return answer(entries, "more", carry({ page: state.page + 1, provider: listed.next, after: null }));
}
