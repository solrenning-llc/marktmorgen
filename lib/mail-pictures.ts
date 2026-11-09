/**
 * A picture for a creator's email, kept (the rules are in
 * lib/mail-picture-rules.ts). Made smaller in the creator's browser before
 * it is sent (components/mail-picture-button.tsx), and held here to the
 * checks every picture on this site is: a JPEG by its own first bytes, its
 * size read from the file itself, at most MAX_MAIL_PICTURE_BYTES, then kept
 * under a new name in the store's own picture folder, never written over.
 *
 * A picture in an email is kept for as long as the store is: an email once
 * sent can be opened years later, and a picture taken away from it would
 * leave a hole in the creator's own words. It counts as a small file in the
 * store's folder, as a product's picture does, and takes room from the
 * store's space (lib/image-space.ts).
 */
import { randomBytes } from "node:crypto";
import { put } from "@/lib/blob";
import { imageFolder } from "@/lib/store";
import { imagePath } from "@/lib/product-image";
import { imageSize } from "@/lib/image-size";
import { sniffPhotoType } from "@/lib/store-photo";
import { MAIL_PICTURE_SIDE, MAX_MAIL_PICTURE_BYTES, pictureUrl } from "@/lib/mail-picture-rules";
import { admitImage } from "@/lib/image-space";

export type CheckedPicture = { bytes: Uint8Array; width: number; height: number };

/** What the browser sent, read and checked before anything is written; "picture" when it is not one we keep. */
export function checkMailPicture(raw: string): CheckedPicture | "picture" {
  const base64 = raw.startsWith("data:") ? raw.slice(raw.indexOf(",") + 1) : raw;
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(base64) || Math.floor((base64.length * 3) / 4) > MAX_MAIL_PICTURE_BYTES + 3) return "picture";
  const bytes = new Uint8Array(Buffer.from(base64, "base64"));
  if (bytes.length === 0 || bytes.length > MAX_MAIL_PICTURE_BYTES) return "picture";
  if (sniffPhotoType(bytes) !== "image/jpeg") return "picture";
  const size = imageSize(bytes);
  if (!size || size.width < 16 || size.height < 16 || Math.max(size.width, size.height) > MAIL_PICTURE_SIDE + 1) return "picture";
  return { bytes, width: size.width, height: size.height };
}

/**
 * Keeps a checked picture and gives the address an email shows it from. Its
 * exact bytes are taken from the store's space (`limit`, its plan's storage)
 * before it is written (owner's decision 8, lib/image-space.ts): past it, or
 * when the room cannot be read, ImageSpaceRefused is thrown and nothing is
 * written.
 */
export async function keepMailPicture(ref: string, checked: CheckedPicture, limit: number): Promise<{ url: string; width: number; height: number }> {
  await admitImage(ref, checked.bytes.length, limit);
  const folder = await imageFolder(ref);
  const name = randomBytes(16).toString("hex");
  const path = imagePath(folder, name, "image/jpeg");
  await put(path, Buffer.from(checked.bytes), { access: "private", contentType: "image/jpeg", addRandomSuffix: false, allowOverwrite: false });
  return { url: pictureUrl(folder, `${name}.jpg`), width: checked.width, height: checked.height };
}
