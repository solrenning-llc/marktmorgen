/**
 * Vercel Blob, with a limit on how long we wait (lib/fetch-timeout.ts).
 *
 * The same functions as "@vercel/blob", taking the same arguments, for every
 * server file to import instead of it. Each call is given an abort signal:
 * BLOB_TIMEOUT_MS (15 s) to an answer — for `get`, until the download
 * starts, never cutting the file short once it is flowing to the buyer —
 * and BLOB_WRITE_TIMEOUT_MS (45 s) for `put`, which writes a stamped PDF of
 * up to 50 MB. The SDK tries a failed request again by itself (up to ten
 * times); the limit covers all of its tries together, so a store that keeps
 * failing cannot hold a page for minutes. Given up, a call fails as one that
 * could not reach Blob does, and every caller already handles that: a
 * download says it could not fetch the file, a removal is logged and left.
 *
 * Signing a URL (presignUrl) is worked out here without asking Blob, so it
 * is passed through as it is.
 *
 * Every write into a store's folder (stores/<folder>/) is tallied before it
 * is sent (lib/blob-tally.ts), because that folder is listed only once a day
 * (owner, 16 November 2026): a put by its bytes, a put token at its maximum
 * size. A write whose size is not known first (a stream, a copy, a put token
 * with no maximum, a long-lived one or one for any path) is refused.
 */
import * as sdk from "@vercel/blob";
import { BLOB_TIMEOUT_MS, BLOB_WRITE_TIMEOUT_MS, timed } from "@/lib/fetch-timeout";
import { BLOB_PUT_TOKEN_MAX_MS, talliedFolder, tallyBlobWrite } from "@/lib/blob-tally";

type Options<F extends (...args: never[]) => unknown, I extends number> = NonNullable<Parameters<F>[I]>;

export function get(pathname: string, options: Options<typeof sdk.get, 1>): ReturnType<typeof sdk.get> {
  return timed(BLOB_TIMEOUT_MS, (abortSignal) => sdk.get(pathname, { ...options, abortSignal }));
}

export function head(pathname: string, options: Options<typeof sdk.head, 1> = {}): ReturnType<typeof sdk.head> {
  return timed(BLOB_TIMEOUT_MS, (abortSignal) => sdk.head(pathname, { ...options, abortSignal }));
}

export function del(pathnames: string | string[], options: Options<typeof sdk.del, 1> = {}): ReturnType<typeof sdk.del> {
  return timed(BLOB_TIMEOUT_MS, (abortSignal) => sdk.del(pathnames, { ...options, abortSignal }));
}

/** A copy made inside the file store (nothing passes through us), BLOB_TIMEOUT_MS to an answer. Never into a store's folder: its size is not known before it. */
export async function copy(from: string, to: string, options: Options<typeof sdk.copy, 2>): ReturnType<typeof sdk.copy> {
  if (talliedFolder(to) !== null) throw new Error("blob_tally_unknown");
  return timed(BLOB_TIMEOUT_MS, (abortSignal) => sdk.copy(from, to, { ...options, abortSignal }));
}

export function list(options: Options<typeof sdk.list, 0> = {}): ReturnType<typeof sdk.list> {
  return timed(BLOB_TIMEOUT_MS, (abortSignal) => sdk.list({ ...options, abortSignal }));
}

/** The bytes a put's body holds, or NaN when they are not known before it is sent (a stream). */
function bodyBytes(body: Parameters<typeof sdk.put>[1]): number {
  if (typeof body === "string") return Buffer.byteLength(body);
  if (body instanceof ArrayBuffer) return body.byteLength;
  if (ArrayBuffer.isView(body)) return body.byteLength;
  if (typeof Blob !== "undefined" && body instanceof Blob) return body.size;
  return Number.NaN;
}

export async function put(
  pathname: string,
  body: Parameters<typeof sdk.put>[1],
  options: Options<typeof sdk.put, 2>,
): ReturnType<typeof sdk.put> {
  if (talliedFolder(pathname) !== null) await tallyBlobWrite(pathname, bodyBytes(body));
  return timed(BLOB_WRITE_TIMEOUT_MS, (abortSignal) => sdk.put(pathname, body, { ...options, abortSignal }));
}

export async function issueSignedToken(options: Options<typeof sdk.issueSignedToken, 0>): ReturnType<typeof sdk.issueSignedToken> {
  if (options.operations?.includes("put")) {
    // A put token is tallied at its maximum size before it is made; one that could reach a store's folder with no
    // known size or for longer than the tally's window is never made.
    const { pathname, maximumSizeInBytes, validUntil } = options;
    if (typeof pathname !== "string" || !pathname || pathname.includes("*")) throw new Error("blob_tally_unknown");
    if (talliedFolder(pathname) !== null) {
      if (typeof maximumSizeInBytes !== "number" || !Number.isSafeInteger(maximumSizeInBytes) || maximumSizeInBytes <= 0 ||
          typeof validUntil !== "number" || !Number.isFinite(validUntil) || validUntil > Date.now() + BLOB_PUT_TOKEN_MAX_MS) throw new Error("blob_tally_unknown");
      await tallyBlobWrite(pathname, maximumSizeInBytes);
    }
  }
  return timed(BLOB_TIMEOUT_MS, (abortSignal) => sdk.issueSignedToken({ ...options, abortSignal }));
}

export const presignUrl: typeof sdk.presignUrl = (...args) => sdk.presignUrl(...args);
