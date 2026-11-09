/**
 * 273 [BK1], files part 1: listing the production R2 bucket and presigning
 * one GET for the backup Worker, with a token of the route's own.
 *
 * The site's own key (R2_ACCESS_KEY_ID / R2_SECRET_ACCESS_KEY, lib/vault.ts)
 * reads and writes. This file never uses it: it signs with an "Object Read
 * only" token scoped to the bucket that the owner creates for the route alone
 * (R2 tokens page, "Last updated Oct 1, 2026", read 2026-11-08), so that even
 * a bug here cannot sign a write or a delete that R2 would accept. A key equal
 * to the site's is refused.
 *
 * Schemes, cited (docs/backup-costs-2026-11-08.md, section 2):
 *   - presigned GET: Signature Version 4 in the query, one operation on one
 *     object, 1 s to 7 days, made locally with no call to R2 (R2 presigned-URL
 *     page, "Last updated Oct 26, 2026", read 2026-11-08); lib/aws-sign.ts
 *     presignV4, held to Amazon's published example and already used for
 *     buyers' downloads (lib/vault.ts vaultUrl);
 *   - listing: S3 ListObjectsV2 (list-type=2, prefix, max-keys, continuation-
 *     token), as lib/vault.ts listVault already asks R2. Each <Contents> must
 *     hold exactly one Key, Size and ETag. That R2's answer carries the ETag
 *     is shown on Cloudflare's own R2 pages: the aws CLI example ("Last
 *     updated Oct 15, 2026") answers `aws s3api list-objects-v2` with
 *     `"ETag": "\"eb2b891dc67b81755d2b726d9110af16\""` in each entry, and the
 *     aws-sdk-js-v3 example ("Last updated Oct 26, 2026") ListObjectsV2Command
 *     with `ETag: '"c4da329b38467509049e615c11b0c48a"'` (both under
 *     developers.cloudflare.com/r2/examples/aws/, read 2026-11-09). These are
 *     examples, not a schema: an entry without its ETag still fails the
 *     listing here, never passes as an empty one.
 *
 * Settings, none set by this work: R2_ACCOUNT_ID and R2_BUCKET (the site's),
 * BACKUP_FILES_R2_READ_KEY_ID and BACKUP_FILES_R2_READ_SECRET (the read-only
 * token's, the owner's to create).
 */
import { type AwsKey, EMPTY_HASH, presignV4, signV4 } from "@/lib/aws-sign";
import { VAULT_TIMEOUT_MS, timed } from "@/lib/fetch-timeout";
import { BACKUP_FILES_PAGE_ENTRIES } from "@/lib/backup-files-contract";

export type BackupFilesR2Config = { endpoint: string; bucket: string; key: AwsKey };

type Env = Record<string, string | undefined>;

/**
 * The route's read-only R2 settings; null when any is missing or the key is the site's own read-write key or the
 * backup bucket's (BACKUP_R2_*: Claude 2's LOW 2, 9 November 2026), as lib/picture-r2.ts refuses both.
 */
export function backupFilesR2Config(env: Env = process.env): BackupFilesR2Config | null {
  const account = (env.R2_ACCOUNT_ID ?? "").trim();
  const bucket = (env.R2_BUCKET ?? "").trim();
  const accessKeyId = (env.BACKUP_FILES_R2_READ_KEY_ID ?? "").trim();
  const secretAccessKey = (env.BACKUP_FILES_R2_READ_SECRET ?? "").trim();
  if (!/^[0-9a-f]{32}$/.test(account) || !/^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$/.test(bucket)) return null;
  if (accessKeyId.length < 16 || secretAccessKey.length < 32) return null;
  if ([env.R2_ACCESS_KEY_ID, env.BACKUP_R2_ACCESS_KEY_ID].some((id) => (id ?? "").trim() === accessKeyId)) return null;
  if ([env.R2_SECRET_ACCESS_KEY, env.BACKUP_R2_SECRET_ACCESS_KEY].some((secret) => (secret ?? "").trim() === secretAccessKey)) return null;
  return { endpoint: `https://${account}.r2.cloudflarestorage.com`, bucket, key: { accessKeyId, secretAccessKey } };
}

/**
 * A presigned GET of one object for `seconds`, made here with no call to R2. The path is built from the key's
 * segments, each percent-encoded, so "?", "#", "%" or "\" stay in the name; a "." or ".." segment, which a URL
 * resolves away, is refused; and the signed address must decode back to exactly this bucket and key, or nothing is
 * handed out (Claude 2's LOW 1, 9 November 2026: one URL for the listed object, whatever the writers allowed).
 */
export function presignR2Get(config: BackupFilesR2Config, key: string, seconds: number, now: Date = new Date()): string {
  const segments = key.split("/");
  if (!key || segments.some((segment) => segment === "." || segment === "..")) throw new Error("R2 sign: a key with a dot segment");
  const path = `/${config.bucket}/${segments.map((segment) => encodeURIComponent(segment)).join("/")}`;
  const signed = presignV4({ method: "GET", url: `${config.endpoint}${path}`, expires: seconds, region: "auto", service: "s3", key: config.key, now });
  const url = new URL(signed);
  const decoded = url.pathname.split("/").map((piece) => decodeURIComponent(piece)).join("/");
  if (url.pathname !== path || decoded !== `/${config.bucket}/${key}` || url.hash !== "" || url.searchParams.has("x-id")) throw new Error("R2 sign: an address that is not the key's");
  return signed;
}

export class R2ListingError extends Error {
  constructor(message: string) {
    super(`R2 listing: ${message}`);
    this.name = "R2ListingError";
  }
}
const fail = (message: string): never => {
  throw new R2ListingError(message);
};

const ESCAPES: Record<string, string> = { "&amp;": "&", "&lt;": "<", "&gt;": ">", "&quot;": '"', "&apos;": "'" };
/** The five XML escapes undone; any other `&` (a numeric reference) is not read. */
function unescape(text: string): string {
  return text.replace(/&[^;]{0,10};|&/g, (found) => ESCAPES[found] ?? fail(`an escape it does not read (${found})`));
}

/** Every element opened is closed in turn, with nothing but comments, CDATA or declarations of other kinds refused. */
function balanced(xml: string): void {
  const open: string[] = [];
  for (const [tag, closing, name, empty] of xml.matchAll(/<(\/?)([A-Za-z_][A-Za-z0-9_.:-]*)(?:\s[^<>]*?)?(\/?)>|<[^>]*>?/g)) {
    if (name === undefined) fail(`a tag it cannot read (${tag.slice(0, 20)})`);
    if (closing) {
      if (open.pop() !== name) fail(`${name} closed out of turn`);
    } else if (!empty) open.push(name);
  }
  if (open.length !== 0) fail(`${open[open.length - 1]} left open`);
}

/** The one value of a tag in an XML fragment, exactly once; anything else fails. */
function once(xml: string, name: string): string {
  const openings = xml.match(new RegExp(`<(?:[A-Za-z_][A-Za-z0-9_.-]*:)?${name}[\\s>/]`, "g")) ?? [];
  const values = [...xml.matchAll(new RegExp(`<${name}>([^<]*)</${name}>`, "g"))];
  if (openings.length !== 1 || values.length !== 1) fail(`${name} is not there exactly once`);
  return unescape(values[0][1]);
}

/** One page of the bucket under `prefix`: each object's key, etag and size, and the token to go on from. Throws on anything not exact (rule 24). */
export async function listR2Page(config: BackupFilesR2Config, prefix: string, cursor: string | null): Promise<{ objects: { key: string; etag: string; size: number }[]; next: string | null }> {
  const url = new URL(`${config.endpoint}/${config.bucket}`);
  url.searchParams.set("list-type", "2");
  url.searchParams.set("prefix", prefix);
  url.searchParams.set("max-keys", String(BACKUP_FILES_PAGE_ENTRIES));
  if (cursor) url.searchParams.set("continuation-token", cursor);
  const headers = signV4({ method: "GET", url: url.toString(), headers: { "x-amz-content-sha256": EMPTY_HASH }, payloadHash: EMPTY_HASH, region: "auto", service: "s3", key: config.key });
  const answer = await timed(VAULT_TIMEOUT_MS, async (signal) => {
    const response = await fetch(url.toString(), { method: "GET", headers: { ...headers, "accept-encoding": "identity" }, signal, cache: "no-store" });
    return { status: response.status, text: await response.text() };
  });
  if (answer.status !== 200) fail(`answered ${answer.status}`);
  const xml = answer.text;
  const opened = xml.indexOf("<ListBucketResult");
  const closed = xml.lastIndexOf("</ListBucketResult>");
  if (opened < 0 || closed < opened || xml.slice(closed + "</ListBucketResult>".length).trim() !== "") fail("not one whole ListBucketResult");
  // Nothing before it but an XML declaration, and every element closed in turn (Codex Z's LOW 2, 9 November 2026):
  // text around the listing, or an element left open, is not a whole listing, never an empty one.
  if (!/^\s*(?:<\?xml[^>]*\?>\s*)?$/.test(xml.slice(0, opened))) fail("text before the ListBucketResult");
  balanced(xml.slice(opened));
  const truncated = once(xml, "IsTruncated");
  if (truncated !== "true" && truncated !== "false") fail("IsTruncated is not true or false");
  const entries = xml.match(/<Contents>[\s\S]*?<\/Contents>/g) ?? [];
  if ((xml.match(/<(?:[A-Za-z_][A-Za-z0-9_.-]*:)?Contents[\s>/]/g) ?? []).length !== entries.length) fail("a Contents it cannot read");
  if (entries.length > BACKUP_FILES_PAGE_ENTRIES) fail("more than 1,000 entries");
  for (const name of ["KeyCount", "MaxKeys"]) {
    if (!new RegExp(`<${name}[\\s>/]`).test(xml.replace(/<Contents>[\s\S]*?<\/Contents>/g, ""))) continue;
    const count = once(xml.replace(/<Contents>[\s\S]*?<\/Contents>/g, ""), name);
    if (!/^\d{1,7}$/.test(count)) fail(`${name} is not a count`);
    if (name === "KeyCount" ? Number(count) !== entries.length : Number(count) < entries.length) fail(`${name} does not match the entries`);
  }
  const seen = new Set<string>();
  const objects = entries.map((entry) => {
    const key = once(entry, "Key");
    const size = once(entry, "Size");
    const etag = once(entry, "ETag").replace(/^"(.*)"$/, "$1");
    if (!key.startsWith(prefix) || key.length === prefix.length || seen.has(key)) fail("an entry outside the prefix, or twice");
    seen.add(key);
    if (!/^\d{1,15}$/.test(size)) fail("a size that is not a count");
    if (!/^[\x21-\x7e]{1,256}$/.test(etag)) fail("an etag it cannot read");
    return { key, etag, size: Number(size) };
  });
  const next = truncated === "true" ? once(xml.replace(/<Contents>[\s\S]*?<\/Contents>/g, ""), "NextContinuationToken") : null;
  if (truncated === "true" && !next) fail("truncated without its token");
  return { objects, next };
}
