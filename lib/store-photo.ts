/**
 * The creator's photo on their public page.
 *
 * It is small on purpose. The browser crops and shrinks the picture before it
 * is sent, so what arrives here is a few tens of kilobytes rather than the
 * twelve megabytes a phone camera produces, and it is kept in Redis next to
 * the store rather than in the file store the products live in. Those files
 * are private and paid for per byte delivered; a face on a page is public and
 * is asked for by every visitor, so it gets an address that never changes and
 * that every browser and cache in between may keep for a year.
 *
 * What is accepted is decided by the bytes, not by what the upload says it
 * is: JPEG, PNG and WebP, and nothing that can carry a script, which is why
 * SVG is not on the list.
 */
import { redisPipeline } from "@/lib/redis";
import { UnknownReplyError, countOf, repliesFor } from "@/lib/redis-reply";

import { MAX_PHOTO_BYTES, PHOTO_ID_PATTERN } from "@/lib/photo-limits";

export { MAX_PHOTO_BYTES, PHOTO_ID_PATTERN, PHOTO_SIDE, photoUrl } from "@/lib/photo-limits";

export type PhotoType = "image/jpeg" | "image/png" | "image/webp";

const photoKey = (id: string) => `nl:store:photo:${id}`;

/** What the first bytes of a file say it is, when it is one of ours. */
export function sniffPhotoType(bytes: Uint8Array): PhotoType | null {
  const starts = (sig: number[], at = 0) => sig.every((b, i) => bytes[at + i] === b);
  if (bytes.length >= 3 && starts([0xff, 0xd8, 0xff])) return "image/jpeg";
  if (bytes.length >= 8 && starts([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) {
    return "image/png";
  }
  if (
    bytes.length >= 12 &&
    starts([0x52, 0x49, 0x46, 0x46]) &&
    starts([0x57, 0x45, 0x42, 0x50], 8)
  ) {
    return "image/webp";
  }
  return null;
}

export type PhotoProblem = "empty" | "too_big" | "type";

/** Reads what the browser sent — base64, with or without a data: prefix. */
export function decodePhoto(raw: unknown): { bytes: Uint8Array; type: PhotoType } | PhotoProblem {
  if (typeof raw !== "string" || !raw) return "empty";
  const base64 = raw.startsWith("data:") ? raw.slice(raw.indexOf(",") + 1) : raw;
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(base64)) return "type";
  // Four characters of base64 carry three bytes, so the size is known before
  // anything is decoded.
  if (Math.floor((base64.length * 3) / 4) > MAX_PHOTO_BYTES + 3) return "too_big";
  const bytes = new Uint8Array(Buffer.from(base64, "base64"));
  if (bytes.length === 0) return "empty";
  if (bytes.length > MAX_PHOTO_BYTES) return "too_big";
  const type = sniffPhotoType(bytes);
  if (!type) return "type";
  return { bytes, type };
}

/** A fresh id for a photo, to be named in the store record before anything is written under it. */
export function newPhotoId(): string {
  return crypto.randomUUID().replace(/-/g, "");
}

/**
 * Keeps a photo under an id (a fresh one unless given) and returns the id.
 * Written only on Redis's exact "OK" (CX-123 rule 24): any other answer throws,
 * so the page is never pointed at a photo that may not be there.
 */
export async function writePhoto(bytes: Uint8Array, type: PhotoType, id = newPhotoId()): Promise<string> {
  const replies = repliesFor(await redisPipeline([
    ["SET", photoKey(id), `${type};${Buffer.from(bytes).toString("base64")}`],
  ]), 1);
  if (!replies || replies[0] !== "OK") throw new UnknownReplyError("writing a store photo: SET");
  return id;
}

/** The photo behind an id, or null when there is none. */
export async function readPhoto(
  id: string,
): Promise<{ bytes: Uint8Array; type: PhotoType } | null> {
  if (!PHOTO_ID_PATTERN.test(id)) return null;
  const [raw] = await redisPipeline([["GET", photoKey(id)]]);
  if (typeof raw !== "string") return null;
  const cut = raw.indexOf(";");
  if (cut < 0) return null;
  const type = raw.slice(0, cut);
  if (type !== "image/jpeg" && type !== "image/png" && type !== "image/webp") return null;
  return { bytes: new Uint8Array(Buffer.from(raw.slice(cut + 1), "base64")), type };
}

/**
 * Deletes photos nothing points at any more. Done only on each DEL's exact
 * count, 0 (already gone) or 1 (CX-123 rule 24): any other answer, or a
 * failure, throws, and whoever keeps their names keeps them until a later try
 * is confirmed (lib/store.ts, photoLeft). /api/photo/<id> reads only the
 * photo's own record, so a photo whose delete is not confirmed is not "removed".
 */
export async function deletePhotos(ids: (string | null)[]): Promise<void> {
  const ours = [...new Set(ids.filter((id): id is string => typeof id === "string" && PHOTO_ID_PATTERN.test(id)))];
  if (ours.length === 0) return;
  const replies = repliesFor(await redisPipeline(ours.map((id) => ["DEL", photoKey(id)])), ours.length);
  if (!replies || replies.some((reply) => { const n = countOf(reply); return n !== 0 && n !== 1; })) {
    throw new UnknownReplyError("deleting a store photo: DEL");
  }
}

/** Deletes one photo nothing points at any more; throws when that is not confirmed. */
export async function deletePhoto(id: string | null): Promise<void> {
  await deletePhotos([id]);
}
