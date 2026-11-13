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
 */
import * as sdk from "@vercel/blob";
import { BLOB_TIMEOUT_MS, BLOB_WRITE_TIMEOUT_MS, timed } from "@/lib/fetch-timeout";
import { deletePictureFromR2, isPicturePath, pictureR2Config } from "@/lib/picture-r2";

type Options<F extends (...args: never[]) => unknown, I extends number> = NonNullable<Parameters<F>[I]>;

export function get(pathname: string, options: Options<typeof sdk.get, 1>): ReturnType<typeof sdk.get> {
  return timed(BLOB_TIMEOUT_MS, (abortSignal) => sdk.get(pathname, { ...options, abortSignal }));
}

export function head(pathname: string, options: Options<typeof sdk.head, 1> = {}): ReturnType<typeof sdk.head> {
  return timed(BLOB_TIMEOUT_MS, (abortSignal) => sdk.head(pathname, { ...options, abortSignal }));
}

/**
 * Deletes from the file store, then, while the pictures' own R2 bucket is on (lib/picture-r2.ts, pictureR2Config),
 * the R2 copy of each picture among them: every deletion of a picture (replaced, withdrawn, taken off a page, its
 * product removed, its store closed) comes through here, so none leaves a public, billed copy behind (#4237 item 4).
 * Off, as today, nothing more is sent. A copy R2 would not delete makes this fail, as a file store failure does.
 */
export async function del(pathnames: string | string[], options: Options<typeof sdk.del, 1> = {}): ReturnType<typeof sdk.del> {
  await timed(BLOB_TIMEOUT_MS, (abortSignal) => sdk.del(pathnames, { ...options, abortSignal }));
  const pictures = (typeof pathnames === "string" ? [pathnames] : pathnames).filter(isPicturePath);
  if (!pictures.length) return;
  const config = pictureR2Config();
  if (!config) return;
  for (const path of pictures) await deletePictureFromR2(config, path);
}

/** A copy made inside the file store (nothing passes through us), BLOB_TIMEOUT_MS to an answer. */
export function copy(from: string, to: string, options: Options<typeof sdk.copy, 2>): ReturnType<typeof sdk.copy> {
  return timed(BLOB_TIMEOUT_MS, (abortSignal) => sdk.copy(from, to, { ...options, abortSignal }));
}

export function list(options: Options<typeof sdk.list, 0> = {}): ReturnType<typeof sdk.list> {
  return timed(BLOB_TIMEOUT_MS, (abortSignal) => sdk.list({ ...options, abortSignal }));
}

export function put(
  pathname: string,
  body: Parameters<typeof sdk.put>[1],
  options: Options<typeof sdk.put, 2>,
): ReturnType<typeof sdk.put> {
  return timed(BLOB_WRITE_TIMEOUT_MS, (abortSignal) => sdk.put(pathname, body, { ...options, abortSignal }));
}

export function issueSignedToken(options: Options<typeof sdk.issueSignedToken, 0>): ReturnType<typeof sdk.issueSignedToken> {
  return timed(BLOB_TIMEOUT_MS, (abortSignal) => sdk.issueSignedToken({ ...options, abortSignal }));
}

export const presignUrl: typeof sdk.presignUrl = (...args) => sdk.presignUrl(...args);
