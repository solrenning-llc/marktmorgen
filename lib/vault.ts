/**
 * The file store that charges nothing for a download.
 *
 * The files a creator sells are kept in Cloudflare R2 when it is set up, and
 * in the host's own file store (lib/blob.ts) when it is not. R2 was chosen
 * for one line of its price list: keeping a gigabyte costs a cent and a half
 * a month, and sending it to a buyer costs nothing, however often. The
 * host's store charges $0.05 to $0.11 for each gigabyte sent, and a paid
 * download is never refused (lib/delivery.ts), so there it was the one cost
 * in the system with no ceiling. Here it is not a cost.
 *
 * R2 is asked in the dialect Amazon's S3 speaks, signed the way Amazon signs
 * (lib/aws-sign.ts, held to Amazon's own worked examples). Three kinds of
 * request leave this file:
 *
 *   - ours, with the signature in the headers: open an upload, close it,
 *     measure a file, delete one, list a folder, read or write a small file
 *     (a buyer's stamped copy of a PDF, lib/pdf-stamp.ts);
 *   - an address for the studio's browser to send one piece of one upload
 *     to, good for an hour and for a piece of exactly the size it was signed
 *     for, so the file goes from the creator's computer straight to the
 *     store and never through this server;
 *   - an address for a buyer's browser to fetch one file from, good for
 *     minutes, saved under the name the creator gave it.
 *
 * An upload is written down when it is opened (what it is, how big the
 * browser said it would be, whose store it is for), and what it is written
 * down as is what its pieces are signed for and what the finished file is
 * held to: a file that turns out to be another size is deleted, not kept.
 *
 * Nothing here runs until the four settings are there:
 *
 *   R2_ACCOUNT_ID          the Cloudflare account, which names the address
 *   R2_ACCESS_KEY_ID       an API token for the bucket, to read and write
 *   R2_SECRET_ACCESS_KEY   objects in it and nothing else
 *   R2_BUCKET              the bucket's name
 *
 *   nl:vault:up:<hash>     an upload that was opened and not yet closed
 */
import { createHash, randomBytes } from "node:crypto";
import { type AwsKey, EMPTY_HASH, hashOf, presignV4, signV4 } from "@/lib/aws-sign";
import { VAULT_TIMEOUT_MS, VAULT_WRITE_TIMEOUT_MS, timed } from "@/lib/fetch-timeout";
import { isRedisConfigured, redisPipeline } from "@/lib/redis";
import {
  PIECE_BYTES,
  PIECE_SECONDS,
  UPLOAD_SECONDS,
  isVaultPath,
  pieceCount,
  pieceSize,
  readVaultPath,
  vaultPath,
} from "@/lib/vault-rules";

type Config = { endpoint: string; bucket: string; key: AwsKey };

const REGION = "auto";
const SERVICE = "s3";

export function vaultConfig(): Config | null {
  const account = (process.env.R2_ACCOUNT_ID ?? "").trim();
  const accessKeyId = (process.env.R2_ACCESS_KEY_ID ?? "").trim();
  const secretAccessKey = (process.env.R2_SECRET_ACCESS_KEY ?? "").trim();
  const bucket = (process.env.R2_BUCKET ?? "").trim();
  if (!/^[0-9a-f]{32}$/.test(account) || accessKeyId.length < 16 || secretAccessKey.length < 32) return null;
  if (!/^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$/.test(bucket)) return null;
  return { endpoint: `https://${account}.r2.cloudflarestorage.com`, bucket, key: { accessKeyId, secretAccessKey } };
}

export function isVaultConfigured(): boolean {
  return vaultConfig() !== null && isRedisConfigured();
}

/** The origin the studio's browser sends pieces to and a buyer's fetches a file from; null when the store is not set up. */
export function vaultOrigin(): string | null {
  return vaultConfig()?.endpoint ?? null;
}

const objectUrl = (config: Config, pathname: string) => `${config.endpoint}/${config.bucket}/${pathname}`;

type Answer = { status: number; text: string; headers: Headers | null };

/**
 * Sent with every request of ours: the file as it is kept, not squeezed.
 *
 * Asked the ordinary way, the store compresses a file of text on its way out
 * (a .txt, a .csv, a .json) and then states no length for it, because the
 * length of what it sends is no longer the length of what it keeps. Found on
 * the first day against the real store: a text file went up whole, and the
 * store's own measure of it came back empty. So we ask for no squeezing.
 * Not part of what is signed: the signature is of the request, and this is
 * only how the answer is to travel.
 */
const AS_KEPT = { "accept-encoding": "identity" };

/** A count of bytes as a header states it; null for anything that is not one. */
function stated(value: string | null | undefined): number | null {
  return typeof value === "string" && /^\d{1,15}$/.test(value.trim()) ? Number(value.trim()) : null;
}

/** One signed request of ours. A status of 0 is a store that could not be reached. */
async function ask(
  config: Config,
  method: string,
  url: string,
  options: { body?: string | Uint8Array; headers?: Record<string, string>; ms?: number } = {},
): Promise<Answer> {
  const payloadHash = options.body === undefined ? EMPTY_HASH : hashOf(options.body);
  const headers = signV4({
    method,
    url,
    headers: { ...(options.headers ?? {}), "x-amz-content-sha256": payloadHash },
    payloadHash,
    region: REGION,
    service: SERVICE,
    key: config.key,
  });
  try {
    return await timed(options.ms ?? VAULT_TIMEOUT_MS, async (signal) => {
      const response = await fetch(url, { method, headers: { ...headers, ...AS_KEPT }, body: options.body as BodyInit | undefined, signal, cache: "no-store" });
      return { status: response.status, text: method === "HEAD" ? "" : await response.text(), headers: response.headers };
    });
  } catch {
    return { status: 0, text: "", headers: null };
  }
}

/** The text between a pair of tags in the store's XML, with its few escapes undone. */
function tag(xml: string, name: string): string | null {
  const found = new RegExp(`<${name}>([^<]*)</${name}>`).exec(xml);
  if (!found) return null;
  return found[1].replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&");
}

// ------------------------------------------------------------------ uploads

/** An upload that was opened: what its pieces are signed for, and what the finished file is held to. */
type Upload = {
  reservation?: string;
  pathname: string;
  /** The store's id for an upload in pieces; empty for a file sent whole. */
  uploadId: string;
  bytes: number;
  type: string;
  at: number;
};

const uploadKey = (pathname: string) => `nl:vault:up:${createHash("sha256").update(pathname).digest("hex").slice(0, 40)}`;

async function readUpload(pathname: string): Promise<Upload | null> {
  if (!isVaultPath(pathname)) return null;
  const [raw] = await redisPipeline([["GET", uploadKey(pathname)]]);
  if (typeof raw !== "string") return null;
  try {
    const value = JSON.parse(raw) as Partial<Upload>;
    if (value.pathname !== pathname || typeof value.bytes !== "number" || !(value.bytes > 0)) return null;
    return { reservation: typeof value.reservation === "string" ? value.reservation : undefined, pathname, uploadId: typeof value.uploadId === "string" ? value.uploadId : "", bytes: value.bytes, type: typeof value.type === "string" ? value.type : "", at: typeof value.at === "number" ? value.at : 0 };
  } catch {
    return null;
  }
}

export type OpenedUpload = {
  pathname: string;
  /** How many pieces the file goes up in. One means it goes whole, to the address of piece 1. */
  pieces: number;
  pieceBytes: number;
  /** Even a single piece needs its ETag when the browser negotiated multipart. */
  multipart?: true;
};

/**
 * Opens an upload of one file onto one product, option or lesson of one
 * store. The caller has already decided the asker may: nothing here does.
 *
 * The path is made here, with a random token, so two files of one name
 * never meet and an upload can never take the place of a file that is
 * already selling.
 */
export async function openVaultUpload(input: {
  folder: string;
  ownerId: string;
  name: string;
  bytes: number;
  type: string;
  /** Opt in for clients that can complete a one-part multipart session. */
  multipart?: boolean;
  reservation?: string;
}): Promise<{ ok: true; upload: OpenedUpload; sessionId: string } | { ok: false; reason: "off" | "invalid" | "unavailable" }> {
  const config = vaultConfig();
  if (!config || !isRedisConfigured()) return { ok: false, reason: "off" };
  if (!Number.isInteger(input.bytes) || input.bytes <= 0) return { ok: false, reason: "invalid" };
  const pathname = vaultPath(input.folder, input.ownerId, randomBytes(8).toString("hex"), input.name);
  if (!readVaultPath(pathname)) return { ok: false, reason: "invalid" };

  const pieces = pieceCount(input.bytes);
  let uploadId = "";
  if (pieces > 1 || input.multipart) {
    const made = await ask(config, "POST", `${objectUrl(config, pathname)}?uploads=`, { headers: { "content-type": input.type } });
    uploadId = made.status === 200 ? (tag(made.text, "UploadId") ?? "") : "";
    if (!uploadId || !/^[A-Za-z0-9._~+/=-]{1,1024}$/.test(uploadId)) return { ok: false, reason: "unavailable" };
  }
  const record: Upload = { reservation: input.reservation, pathname, uploadId, bytes: input.bytes, type: input.type, at: Date.now() };
  await redisPipeline([["SET", uploadKey(pathname), JSON.stringify(record), "EX", UPLOAD_SECONDS]]);
  return { ok: true, sessionId: uploadId, upload: { pathname, pieces, pieceBytes: PIECE_BYTES, ...(input.multipart ? { multipart: true as const } : {}) } };
}

/**
 * Addresses for the browser to send these pieces to. Each is good for an
 * hour: that piece of that upload, of exactly the size
 * the piece has in a file of the size the upload was opened for. A piece of
 * any other size no longer matches the signature and is refused by the
 * store itself.
 */
export async function signPieces(pathname: string, numbers: number[]): Promise<{ number: number; url: string; type: string | null }[] | null> {
  const config = vaultConfig();
  if (!config || !isRedisConfigured()) return null;
  const upload = await readUpload(pathname);
  if (!upload) return null;
  const out: { number: number; url: string; type: string | null }[] = [];
  for (const number of numbers) {
    const size = pieceSize(upload.bytes, number);
    if (!size) return null;
    const whole = upload.uploadId === "";
    const url = whole ? objectUrl(config, pathname) : `${objectUrl(config, pathname)}?partNumber=${number}&uploadId=${encodeURIComponent(upload.uploadId)}`;
    out.push({
      number,
      // A file sent whole carries its type with it, and the type is signed
      // too, so the file is kept as what the studio was allowed to send.
      type: whole ? upload.type : null,
      url: presignV4({
        method: "PUT",
        url,
        headers: { "content-length": String(size), ...(whole ? { "content-type": upload.type } : {}) },
        expires: PIECE_SECONDS,
        region: REGION,
        service: SERVICE,
        key: config.key,
      }),
    });
  }
  return out;
}

export type StoredFile = { pathname: string; bytes: number; contentType: string };

/**
 * Closes an upload: the pieces are joined, and the file is measured by the
 * store itself. `etags` are what the store answered for each piece, in
 * order. A file that is not the size the upload was opened for is deleted
 * and refused: the studio said one thing and sent another.
 */
export async function closeVaultUpload(
  pathname: string,
  etags: string[],
): Promise<{ ok: true; file: StoredFile } | { ok: false; reason: "unknown" | "invalid" | "unavailable" | "off" }> {
  const config = vaultConfig();
  if (!config || !isRedisConfigured()) return { ok: false, reason: "off" };
  const upload = await readUpload(pathname);
  if (!upload) return { ok: false, reason: "unknown" };

  if (upload.uploadId) {
    const count = pieceCount(upload.bytes);
    if (etags.length !== count || !etags.every((etag) => /^"?[0-9a-fA-F]{32}(-\d{1,5})?"?$/.test(etag))) return { ok: false, reason: "invalid" };
    const body =
      "<CompleteMultipartUpload>" +
      etags.map((etag, i) => `<Part><PartNumber>${i + 1}</PartNumber><ETag>"${etag.replace(/"/g, "")}"</ETag></Part>`).join("") +
      "</CompleteMultipartUpload>";
    const joined = await ask(config, "POST", `${objectUrl(config, pathname)}?uploadId=${encodeURIComponent(upload.uploadId)}`, {
      body,
      headers: { "content-type": "application/xml" },
      ms: VAULT_WRITE_TIMEOUT_MS,
    });
    // The store can answer 200 and say in the body that it failed.
    if (joined.status === 0 || joined.status >= 500) return { ok: false, reason: "unavailable" };
    if (joined.status !== 200 || /<Error>/.test(joined.text)) return { ok: false, reason: "invalid" };
  }

  const found = await headVault(pathname);
  if (found === "unreachable") return { ok: false, reason: "unavailable" };
  if (!found) return { ok: false, reason: "invalid" };
  if (found.bytes !== upload.bytes) {
    await deleteVault([pathname]);
    await redisPipeline([["DEL", uploadKey(pathname)]]);
    return { ok: false, reason: "invalid" };
  }
  await redisPipeline([["DEL", uploadKey(pathname)]]);
  return { ok: true, file: { pathname, bytes: found.bytes, contentType: found.contentType || upload.type } };
}

/** Forgets an upload only after the provider confirms its cancellation. */
export async function abortVaultUpload(pathname: string): Promise<boolean> {
  const config = vaultConfig();
  if (!config || !isRedisConfigured()) return false;
  const upload = await readUpload(pathname);
  if (!upload) return true;
  const url = upload.uploadId
    ? `${objectUrl(config, pathname)}?uploadId=${encodeURIComponent(upload.uploadId)}`
    : objectUrl(config, pathname);
  const answer = await ask(config, "DELETE", url);
  if (![200, 204].includes(answer.status)) {
    // A missing session may belong to an ambiguous completion. Only a
    // positively observed completed object can then replace reserved bytes.
    const completed = answer.status === 404 ? await headVault(pathname) : null;
    if (!completed || completed === "unreachable") return false;
  }
  await redisPipeline([["DEL", uploadKey(pathname)]]);
  return true;
}

// -------------------------------------------------------------------- files

/** How big a file is and what it is, by the store's own measure; null when it is not there. */
export async function headVault(pathname: string): Promise<{ bytes: number; contentType: string } | null | "unreachable"> {
  const config = vaultConfig();
  if (!config || !isVaultPath(pathname)) return null;
  const url = objectUrl(config, pathname);
  const answer = await ask(config, "HEAD", url);
  if (answer.status === 404) return null;
  if (answer.status !== 200 || !answer.headers) return "unreachable";
  const contentType = (answer.headers.get("content-type") ?? "").split(";")[0].trim();
  const length = stated(answer.headers.get("content-length"));
  // The length is the file's own only when the file is sent as it is kept.
  if (length !== null && !answer.headers.get("content-encoding")) return { bytes: length, contentType };
  // The store squeezed it all the same, or stated no length. One byte of the
  // file is asked for instead: a part of a file is never squeezed, and the
  // answer says how long the whole is. A size is never made up: a file whose
  // size cannot be read is out of reach, not empty.
  const first = await ask(config, "GET", url, { headers: { range: "bytes=0-0" } });
  if (first.status === 404) return null;
  // Nothing to give a first byte of: the file is there and empty.
  if (first.status === 416) return { bytes: 0, contentType };
  const whole = first.status === 206 ? /^bytes 0-0\/(\d{1,15})$/.exec((first.headers?.get("content-range") ?? "").trim()) : null;
  if (!whole) return "unreachable";
  return { bytes: Number(whole[1]), contentType };
}

/** Deletes these files. True when every one is gone, or was never there. */
export async function deleteVault(pathnames: string[]): Promise<boolean> {
  const config = vaultConfig();
  if (!config) return false;
  let all = true;
  for (const pathname of pathnames) {
    if (!isVaultPath(pathname)) continue;
    const answer = await ask(config, "DELETE", objectUrl(config, pathname));
    if (answer.status !== 204 && answer.status !== 200 && answer.status !== 404) all = false;
  }
  return all;
}

/**
 * An address a browser can fetch one file from, for `seconds`. `saveAs`
 * makes the browser save it under that name instead of opening it; the type
 * it is sent as is the one the file was stored with.
 */
export function vaultUrl(pathname: string, seconds: number, saveAs?: string): string | null {
  const config = vaultConfig();
  if (!config || !isVaultPath(pathname)) return null;
  const url = new URL(objectUrl(config, pathname));
  if (saveAs) {
    // The name twice, as browsers want it: plain for the old ones, and
    // encoded so that any character survives.
    const plain = saveAs.replace(/[^\x20-\x7e]/g, "_").replace(/["\\]/g, "_");
    url.searchParams.set("response-content-disposition", `attachment; filename="${plain}"; filename*=UTF-8''${encodeURIComponent(saveAs)}`);
  }
  return presignV4({ method: "GET", url: url.toString(), expires: seconds, region: REGION, service: SERVICE, key: config.key });
}

/** Reads a small file whole, refusing to hold more than `limit` bytes. Null when it is missing, too big, or out of reach. */
export async function readVault(pathname: string, limit: number): Promise<Uint8Array | null> {
  const config = vaultConfig();
  if (!config || !isVaultPath(pathname)) return null;
  const url = objectUrl(config, pathname);
  const headers = signV4({ method: "GET", url, headers: { "x-amz-content-sha256": EMPTY_HASH }, payloadHash: EMPTY_HASH, region: REGION, service: SERVICE, key: config.key });
  try {
    return await timed(VAULT_WRITE_TIMEOUT_MS, async (signal) => {
      const response = await fetch(url, { headers: { ...headers, ...AS_KEPT }, signal, cache: "no-store" });
      if (response.status !== 200 || !response.body) return null;
      if (Number(response.headers.get("content-length") ?? "0") > limit) {
        await response.body.cancel().catch(() => {});
        return null;
      }
      const reader = response.body.getReader();
      const parts: Uint8Array[] = [];
      let total = 0;
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        total += value.byteLength;
        if (total > limit) {
          await reader.cancel().catch(() => {});
          return null;
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
  } catch {
    return null;
  }
}

/** Writes a small file whole, in place of whatever was at that path. */
export async function writeVault(pathname: string, bytes: Uint8Array, contentType: string): Promise<boolean> {
  const config = vaultConfig();
  if (!config || !isVaultPath(pathname)) return false;
  const answer = await ask(config, "PUT", objectUrl(config, pathname), { body: bytes, headers: { "content-type": contentType }, ms: VAULT_WRITE_TIMEOUT_MS });
  return answer.status === 200;
}

/** One page of what is kept under a prefix: each file's path and size, and where to go on from. */
/** Listing evidence is data: a repeated field or one with unsupported attributes or namespace
 * that this adapter cannot interpret is unavailable, never an absent zero.
 * This is not a general XML validator or a bound on network/body bytes. */
function listingField(xml: string, name: "IsTruncated" | "KeyCount" | "MaxKeys"): string | null | undefined {
  const openings = xml.match(new RegExp("<(?:[A-Za-z_][A-Za-z0-9_.-]*:)?" + name + "[^A-Za-z0-9_.:-]", "g")) ?? [];
  if (openings.length === 0) return undefined;
  const fields = [...xml.matchAll(new RegExp("<" + name + ">([^<]*)</" + name + ">", "g"))];
  return openings.length === 1 && fields.length === 1 ? fields[0][1] : null;
}

export async function listVault(prefix: string, cursor?: string): Promise<{ files: { pathname: string; bytes: number }[]; cursor: string | null } | null> {
  const config = vaultConfig();
  if (!config) return null;
  const url = new URL(`${config.endpoint}/${config.bucket}`);
  url.searchParams.set("list-type", "2");
  url.searchParams.set("prefix", prefix);
  url.searchParams.set("max-keys", "1000");
  if (cursor) url.searchParams.set("continuation-token", cursor);
  const answer = await ask(config, "GET", url.toString());
  if (answer.status !== 200) return null;
  const truncated = listingField(answer.text, "IsTruncated");
  if (!answer.text.includes("<ListBucketResult") || !answer.text.includes("</ListBucketResult>") || (truncated !== "true" && truncated !== "false")) return null;
  const files: { pathname: string; bytes: number }[] = [];
  const entries = answer.text.match(/<Contents>[\s\S]*?<\/Contents>/g) ?? [];
  if (entries.length > 1000 || (answer.text.match(/<(?:[A-Za-z_][A-Za-z0-9_.-]*:)?Contents[^A-Za-z0-9_.:-]/g) ?? []).length !== entries.length) return null;
  for (const name of ["KeyCount", "MaxKeys"] as const) {
    const value = listingField(answer.text, name);
    if (value === undefined) continue; // Retain compatible replies without optional count fields.
    if (value === null || !/^\d+$/.test(value)) return null;
    const count = Number(value);
    if (!Number.isSafeInteger(count) || count > 1000 ||
        (name === "KeyCount" ? count !== entries.length : count < entries.length)) return null;
  }
  for (const entry of entries) {
    const pathname = tag(entry, "Key");
    const size = tag(entry, "Size");
    const bytes = size && /^\d+$/.test(size) ? Number(size) : NaN;
    if (!pathname || !pathname.startsWith(prefix) || !Number.isSafeInteger(bytes) || bytes < 0) return null;
    files.push({ pathname, bytes });
  }
  const more = truncated === "true" ? tag(answer.text, "NextContinuationToken") : null;
  if (truncated === "true" && !more) return null;
  return { files, cursor: more };
}

/** How many bytes a store keeps here. Null when it cannot be read. */
export async function vaultHeld(folder: string): Promise<number | null> {
  if (!vaultConfig()) return 0;
  let bytes = 0;
  let cursor: string | undefined;
  const seen = new Set<string>();
  const paths = new Set<string>();
  for (let page = 0; page < 20; page += 1) {
    const answer = await listVault(`vault/${folder}/`, cursor);
    if (!answer) return null;
    for (const file of answer.files) {
      if (paths.has(file.pathname) || !Number.isSafeInteger(file.bytes) || file.bytes < 0) return null;
      paths.add(file.pathname);
      bytes += file.bytes;
      if (!Number.isSafeInteger(bytes)) return null;
    }
    if (!answer.cursor) return bytes;
    if (seen.has(answer.cursor)) return null;
    seen.add(answer.cursor);
    cursor = answer.cursor;
  }
  return null;
}

export async function vaultReservationId(pathname: string): Promise<string | undefined> {
  return (await readUpload(pathname))?.reservation;
}

/** Cancels a known multipart session even after the short-lived upload record expires. */
export async function retireVaultSession(pathname: string, uploadId: string): Promise<boolean> {
  const config = vaultConfig();
  if (!config || !readVaultPath(pathname) || !/^[A-Za-z0-9._~+\/=-]{1,1024}$/.test(uploadId)) return false;
  const answer = await ask(config, "DELETE", objectUrl(config, pathname) + "?uploadId=" + encodeURIComponent(uploadId));
  if ([200, 204].includes(answer.status)) return true;
  if (answer.status !== 404) return false;
  const completed = await headVault(pathname);
  return completed !== null && completed !== "unreachable";
}
