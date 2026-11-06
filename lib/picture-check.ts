/**
 * Whether a file in the picture folder really is a picture.
 *
 * What a browser says it uploaded is never taken at face value
 * (app/api/store/image): the file store is asked how big the file really is
 * and what it says it is, and its first bytes have to be a JPEG's or a
 * WebP's. The same check, for a picture put on a product's page
 * (lib/sales-page.ts, PicturesBlock).
 */
import { del, get, head } from "@/lib/blob";
import { IMAGE_CONTENT_TYPES, MAX_IMAGE_BYTES } from "@/lib/product-image";
import { sniffPhotoType } from "@/lib/store-photo";

/** The first bytes of a stored file, to see what it really is. */
async function firstBytes(path: string): Promise<Uint8Array | null> {
  const found = await get(path, { access: "private" });
  if (!found || found.statusCode !== 200 || !found.stream) return null;
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

/** True when the file is there, weighs no more than a picture may, and is a JPEG or a WebP by its own bytes. */
export async function isStoredPicture(path: string): Promise<boolean> {
  try {
    const found = await head(path);
    if (found.size > MAX_IMAGE_BYTES) return false;
    const bytes = await firstBytes(path);
    const kind = bytes ? sniffPhotoType(bytes) : null;
    return kind !== null && (IMAGE_CONTENT_TYPES as readonly string[]).includes(kind) && kind === found.contentType;
  } catch {
    return false;
  }
}

/**
 * Of the pictures a page save has just taken from the picture door (lib/sales-page-store.ts, claimNewPictures, before
 * any is written down as the page's), checks each in the file store, once (MR audit gap 1: a save tried again never
 * asks Blob about the same picture twice). Answers those that are pictures; any other is deleted: taken from the door
 * by this very save, it is nobody else's, so deleting it can never take a file from another record.
 */
export async function checkedPictures(taken: string[]): Promise<string[]> {
  const good: string[] = [];
  const bad: string[] = [];
  for (const path of taken) (await isStoredPicture(path) ? good : bad).push(path);
  if (bad.length) await del(bad).catch((error: unknown) => console.error("could not delete files that are not pictures", error));
  return good;
}
