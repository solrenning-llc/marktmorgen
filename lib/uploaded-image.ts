/**
 * What a picture the browser says it uploaded really is.
 *
 * The browser sends a picture straight to the file store and then tells us
 * where it put it. That is never taken at face value: the file store is asked
 * how big the file really is and what it says it is, and its first bytes have
 * to be a JPEG's or a WebP's (lib/store-photo.ts, sniffPhotoType). Shared by
 * a product's picture (app/api/store/image) and a link's
 * (app/api/store/link-image).
 */
import { get, head } from "@/lib/blob";
import { IMAGE_CONTENT_TYPES, MAX_IMAGE_BYTES } from "@/lib/product-image";
import { sniffPhotoType } from "@/lib/store-photo";

/** The first bytes of a stored picture, to see what it really is. */
export async function firstBytes(path: string): Promise<Uint8Array | null> {
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

/**
 * Whether an uploaded file is a picture we keep: at most MAX_IMAGE_BYTES, a
 * JPEG or a WebP by its own bytes, and saying so to the file store too.
 * Nothing is deleted here: the path came from the browser and may be another
 * record's picture, so only the caller that took it from the picture door
 * (lib/picture-door.ts) may delete it.
 */
export async function checkUploadedImage(
  path: string,
): Promise<{ ok: true; bytes: number } | { ok: false; error: "too_big" | "type" }> {
  const found = await head(path);
  if (found.size > MAX_IMAGE_BYTES) {
    return { ok: false, error: "too_big" };
  }
  const bytes = await firstBytes(path);
  const kind = bytes ? sniffPhotoType(bytes) : null;
  if (!kind || !(IMAGE_CONTENT_TYPES as readonly string[]).includes(kind) || kind !== found.contentType) {
    return { ok: false, error: "type" };
  }
  return { ok: true, bytes: found.size };
}
