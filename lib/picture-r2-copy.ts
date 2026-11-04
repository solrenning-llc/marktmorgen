/**
 * 313 [CV1] unit 4b: a product picture, and its smaller copy, copied to the pictures' own R2 bucket as they are
 * attached, when that bucket is on (lib/picture-r2.ts, pictureR2Config: off until the owner's settings and the
 * reviewed request ceiling exist). Off, nothing is read and nothing is sent. Each file is read once from the file
 * store, at most MAX_IMAGE_BYTES, and written create-only; a copy that fails leaves the picture as it was, served
 * from where it always was. Nothing serves from R2 yet: addressing marked pictures is unit 4c.
 */
import { get } from "@/lib/blob";
import { copyPictureToR2, pictureR2Config, type PictureR2Config } from "@/lib/picture-r2";
import { MAX_IMAGE_BYTES } from "@/lib/product-image";

/** A picture's whole file from the file store, at most MAX_IMAGE_BYTES; it throws on anything else. */
async function readPicture(path: string): Promise<Uint8Array> {
  const found = await get(path, { access: "private" });
  if (!found || found.statusCode !== 200 || !found.stream) throw new Error("Picture not found");
  const reader = found.stream.getReader();
  const parts: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > MAX_IMAGE_BYTES) {
      await reader.cancel().catch(() => {});
      throw new Error("Picture larger than a picture may be");
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
}

/** True when every file was copied (or was already there under its fresh name); false when off or on any failure. */
export async function copyAttachedPicture(
  paths: readonly string[],
  options: { config?: PictureR2Config | null; read?: (path: string) => Promise<Uint8Array> } = {},
): Promise<boolean> {
  const config = "config" in options ? options.config : pictureR2Config();
  if (!config || paths.length === 0) return false;
  const read = options.read ?? readPicture;
  try {
    for (const path of paths) await copyPictureToR2(config, path, await read(path));
    return true;
  } catch (error) {
    console.error("copying a picture to its own bucket failed; it stays where it was", error);
    return false;
  }
}
