/**
 * Whether a file in the picture folder really is a picture.
 *
 * What a browser says it uploaded is never taken at face value
 * (app/api/store/image): the file store is asked how big the file really is
 * and what it says it is, and its first bytes have to be a JPEG's or a
 * WebP's. The same check, for a picture put on a product's page
 * (lib/sales-page.ts, PicturesBlock).
 */
import { BlobNotFoundError } from "@vercel/blob";
import { del, get, head } from "@/lib/blob";
import { givePictureDoorBack } from "@/lib/picture-door";
import { IMAGE_CONTENT_TYPES, MAX_IMAGE_BYTES } from "@/lib/product-image";
import { sniffPhotoType } from "@/lib/store-photo";

/**
 * The first bytes of a stored file, to see what it really is; null when the file store says it is not there (404).
 * Any other answer without the file's bytes throws: unknown, never "not a picture".
 */
async function firstBytes(path: string): Promise<Uint8Array | null> {
  const found = await get(path, { access: "private" });
  if (!found) return null;
  if (found.statusCode !== 200 || !found.stream) throw new Error(`a picture's read answered ${found.statusCode}`);
  const reader = found.stream.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  while (length < 16) {
    const { done, value } = await reader.read();
    if (done || !value) break;
    chunks.push(value);
    length += value.length;
  }
  await reader.cancel().catch(() => {});
  const bytes = new Uint8Array(length);
  let at = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, at);
    at += chunk.length;
  }
  return bytes;
}

/**
 * What the file store proves about a file: a picture; not one (not there, too big, or its own bytes are not a JPEG's
 * or a WebP's the store agrees with), with when it was stored (NaN when it is not there); or unknown, when a head or a
 * read failed any other way (a timeout, a 5xx, a reset), saying whether a read was sent. Never throws.
 */
type Verdict = { kind: "picture" } | { kind: "not_picture"; storedAt: number } | { kind: "unknown"; read: boolean };

async function verdictOf(path: string): Promise<Verdict> {
  let found: Awaited<ReturnType<typeof head>>;
  try {
    found = await head(path);
  } catch (error) {
    return error instanceof BlobNotFoundError ? { kind: "not_picture", storedAt: Number.NaN } : { kind: "unknown", read: false };
  }
  const storedAt = new Date(found.uploadedAt).getTime();
  if (found.size > MAX_IMAGE_BYTES) return { kind: "not_picture", storedAt };
  let bytes: Uint8Array | null;
  try {
    bytes = await firstBytes(path);
  } catch {
    return { kind: "unknown", read: true };
  }
  const kind = bytes ? sniffPhotoType(bytes) : null;
  const good = kind !== null && (IMAGE_CONTENT_TYPES as readonly string[]).includes(kind) && kind === found.contentType;
  return good ? { kind: "picture" } : { kind: "not_picture", storedAt };
}

/** True when the file is there, weighs no more than a picture may, and is a JPEG or a WebP by its own bytes. */
export async function isStoredPicture(path: string): Promise<boolean> {
  return (await verdictOf(path)).kind === "picture";
}

/** What checkedPictures answers: the pictures, and those whose check met an unknown (kept, never deleted). */
export type PictureChecks = { good: string[]; unknown: string[] };

/**
 * Of the pictures a page save has just taken from the picture door (lib/sales-page-store.ts, claimNewPictures, before
 * any is written down as the page's), with when the door signed for each, checks each in the file store, once (MR
 * audit gap 1: a save tried again never asks Blob about the same picture twice). Answers those that are pictures.
 *
 * Only a check that proves a file is not a picture deletes it, and only a file stored strictly after the door noted
 * it (the second check dropTakenPictures makes, from the head this check already sent): taken from the door by this
 * very save, it is nobody else's. A check that met an unknown (a passing outage of the file store) deletes nothing and
 * is answered as unknown, so the save is refused as one to try again (Claude 2 on #2843, MEDIUM). When nothing was
 * read yet, its note is given back to the door once (lib/picture-door.ts, givePictureDoorBack), so the creator's save
 * tried again checks it within the same one check; once read, it is never read again: kept, unchecked, refused.
 */
export async function checkedPictures(taken: Map<string, number>): Promise<PictureChecks> {
  const good: string[] = [];
  const bad: string[] = [];
  const unknown: string[] = [];
  const again = new Map<string, number>();
  for (const [path, noted] of taken) {
    const verdict = await verdictOf(path);
    if (verdict.kind === "picture") good.push(path);
    else if (verdict.kind === "unknown") {
      unknown.push(path);
      if (!verdict.read) again.set(path, noted);
    } else if (Number.isFinite(verdict.storedAt) && verdict.storedAt > noted) bad.push(path);
  }
  if (bad.length) await del(bad).catch((error: unknown) => console.error("could not delete files that are not pictures", error));
  if (again.size) await givePictureDoorBack(again);
  return { good, unknown };
}
