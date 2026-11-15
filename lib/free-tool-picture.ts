/**
 * 244 [SP1], unit 3: the picture tool's rules (components/free-tool-picture.tsx). The sizes are the store's own
 * (lib/product-image.ts): what the studio shrinks a product picture to, so a creator can see and use it before
 * opening a store. Pure and browser-safe: no request, nothing kept.
 */
import { IMAGE_LONG_SIDE, MAX_IMAGE_BYTES, MAX_SOURCE_BYTES } from "@/lib/product-image";

/** The long side a product picture is kept at. */
export const PICTURE_LONG_SIDE = IMAGE_LONG_SIDE;
/** The most a kept product picture weighs. */
export const PICTURE_MAX_BYTES = MAX_IMAGE_BYTES;
/** The biggest file opened, as in the studio. */
export const PICTURE_MAX_SOURCE_BYTES = MAX_SOURCE_BYTES;
/** The kinds of file the browser is asked to open. */
export const PICTURE_ACCEPT = "image/jpeg,image/png,image/webp";

/** Why a chosen file is not opened, or null when it may be. */
export function sourceProblem(file: { type: string; size: number }): "type" | "size" | "empty" | null {
  if (!PICTURE_ACCEPT.split(",").includes(file.type)) return "type";
  if (!(file.size > 0)) return "empty";
  if (file.size > PICTURE_MAX_SOURCE_BYTES) return "size";
  return null;
}

/** "my-photo-1600x1200.webp": the original name made safe, with the result's size and type. */
export function pictureFileName(original: string, width: number, height: number, type: string): string {
  const base = original
    .replace(/\.[a-z0-9]{1,5}$/i, "")
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40);
  return `${base || "picture"}-${width}x${height}.${type === "image/jpeg" ? "jpg" : "webp"}`;
}

/** "240 KB", "1.5 MB": a file's size for people, in binary units as file managers show them. */
export function sizeInWords(bytes: number): string {
  if (bytes < 1024 * 1024) return `${Math.max(1, Math.round(bytes / 1024))} KB`;
  return `${(bytes / (1024 * 1024)).toLocaleString("en-US", { maximumFractionDigits: 1 })} MB`;
}
