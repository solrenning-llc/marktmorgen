/**
 * A buyer's photo on their review (lib/review-summary.ts, ReviewPhoto; added
 * 10 October 2026). Shrunk in the buyer's browser before it is sent
 * (components/review-photo-field.tsx), and held here to the same checks a
 * creator's picture is: a JPEG or a WebP by its own first bytes, its size
 * read from the file itself, at most MAX_REVIEW_PHOTO_BYTES, then kept in the
 * store's own picture folder and served from there (lib/product-image.ts).
 * Nothing the form says about the file is believed.
 */
import { randomBytes } from "node:crypto";
import { del, put } from "@/lib/blob";
import { imageFolder } from "@/lib/store";
import { imagePath } from "@/lib/product-image";
import { imageSize } from "@/lib/image-size";
import { sniffPhotoType } from "@/lib/store-photo";
import { MAX_REVIEW_PHOTO_BYTES, REVIEW_PHOTO_SIDE, type ReviewPhoto } from "@/lib/review-summary";

export type PhotoProblem = "photo";

export type CheckedPhoto = { bytes: Uint8Array; type: "image/jpeg" | "image/webp"; width: number; height: number };

/** What the form sent, read and checked, before anything is written; "photo" when it is not one we keep. */
export function checkReviewPhoto(raw: string): CheckedPhoto | PhotoProblem {
  const base64 = raw.startsWith("data:") ? raw.slice(raw.indexOf(",") + 1) : raw;
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(base64) || Math.floor((base64.length * 3) / 4) > MAX_REVIEW_PHOTO_BYTES + 3) return "photo";
  const bytes = new Uint8Array(Buffer.from(base64, "base64"));
  if (bytes.length === 0 || bytes.length > MAX_REVIEW_PHOTO_BYTES) return "photo";
  const type = sniffPhotoType(bytes);
  if (type !== "image/webp" && type !== "image/jpeg") return "photo";
  const size = imageSize(bytes);
  if (!size || size.width < 16 || size.height < 16 || Math.max(size.width, size.height) > REVIEW_PHOTO_SIDE + 1) return "photo";
  return { bytes, type, width: size.width, height: size.height };
}

/** Where a checked photo is kept: a new name in the store's own picture folder. */
export async function reviewPhotoPath(ref: string, type: CheckedPhoto["type"]): Promise<string> {
  return imagePath(await imageFolder(ref), randomBytes(16).toString("hex"), type);
}

/**
 * A checked photo, kept: one put to the file store (a paid operation). The review route makes it only once the
 * review's own write granted it a slot (lib/reviews.ts, saveReview, MAX_REVIEW_PHOTOS); throws when the put fails.
 */
export async function putReviewPhoto(ref: string, checked: CheckedPhoto): Promise<ReviewPhoto> {
  const path = await reviewPhotoPath(ref, checked.type);
  await put(path, Buffer.from(checked.bytes), { access: "private", contentType: checked.type, addRandomSuffix: false, allowOverwrite: false });
  return { path, width: checked.width, height: checked.height };
}

/** Deletes a photo no review points at any more. Best effort. */
export async function dropReviewPhoto(photo: ReviewPhoto | null | undefined): Promise<void> {
  if (photo) await del(photo.path).catch((error: unknown) => console.error("could not delete a review's photo", error));
}
