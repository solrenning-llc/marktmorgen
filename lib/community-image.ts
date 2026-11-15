/**
 * The one picture a community post may carry.
 *
 * It travels exactly as a product picture does (lib/product-image.ts): shrunk
 * in the member's browser to at most 1600 pixels on its long side and one
 * megabyte, sent straight to the private file store through a door that
 * names the one path it may write, and checked by its first bytes before any
 * post points at it. Only JPEG and WebP are kept; nothing that can carry a
 * script, SVG included, is ever accepted.
 *
 * Unlike a product picture it is not public. It is served through a route
 * that asks, on every request, whether the browser asking may read the
 * community (app/api/store/community/image), and it tells browsers to keep
 * it privately rather than in any shared cache.
 *
 * Each community's pictures live in a folder of their own, named from the
 * community's id with a salt of its own, so the folder of one community says
 * nothing about another's, or about where a store's paid files are kept.
 */
import { createHash } from "node:crypto";
import { IMAGE_CONTENT_TYPES, MAX_IMAGE_BYTES } from "@/lib/product-image";
import { sniffPhotoType } from "@/lib/store-photo";

export const COMMUNITY_FOLDER_PATTERN = /^[0-9a-f]{24}$/;
export const COMMUNITY_FILE_PATTERN = /^[0-9a-f]{32}\.(webp|jpg)$/;
const PATH_PATTERN = /^community\/[0-9a-f]{24}\/[0-9a-f]{32}\.(webp|jpg)$/;

/** The folder a community's pictures are kept in. */
export function communityFolder(communityId: string): string {
  return createHash("sha256").update(`nimbus-community-images:${communityId}`).digest("hex").slice(0, 24);
}

/** Whether a path is a picture in this community's own folder. */
export function ownsCommunityImage(path: string, communityId: string): boolean {
  return PATH_PATTERN.test(path) && path.startsWith(`community/${communityId ? communityFolder(communityId) : "-"}/`);
}

/** The file's own name, which is all the serving route needs besides the store. */
export function communityImageFile(path: string): string {
  return path.slice(path.lastIndexOf("/") + 1);
}

export function communityImageType(file: string): "image/webp" | "image/jpeg" {
  return file.endsWith(".jpg") ? "image/jpeg" : "image/webp";
}

/** What the file store is asked, so the checks can be run against a stand-in. */
export type ImageStore = {
  head(path: string): Promise<{ size: number; contentType: string }>;
  firstBytes(path: string): Promise<Uint8Array | null>;
  del(path: string): Promise<void>;
};

export type ImageCheck = "ok" | "path" | "too_big" | "type" | "missing";

/**
 * Checks an uploaded picture before a post may point at it: in this
 * community's folder, no bigger than a megabyte, and a JPEG or a WebP by its
 * first bytes, matching what the upload said it was. Anything that fails is
 * deleted, so nothing unchecked stays in the store.
 */
export async function checkCommunityImage(path: string, communityId: string, files: ImageStore): Promise<ImageCheck> {
  if (!ownsCommunityImage(path, communityId)) return "path";
  let found: { size: number; contentType: string };
  try {
    found = await files.head(path);
  } catch {
    return "missing";
  }
  if (found.size > MAX_IMAGE_BYTES) {
    await files.del(path).catch(() => {});
    return "too_big";
  }
  // Not caught (CX-123 rule 24): first bytes that could not be read are not a wrong type. The picture is neither
  // deleted nor refused for it; the caller keeps it for the member to send again, as for a head that failed.
  const bytes = await files.firstBytes(path);
  const kind = bytes ? sniffPhotoType(bytes) : null;
  const expected = communityImageType(path);
  if (!kind || !(IMAGE_CONTENT_TYPES as readonly string[]).includes(kind) || kind !== found.contentType || kind !== expected) {
    await files.del(path).catch(() => {});
    return "type";
  }
  return "ok";
}
