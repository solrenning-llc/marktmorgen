/**
 * A product's picture, and how its card is laid out on the store page.
 *
 * The picture is shrunk in the creator's browser before it is sent — at most
 * 1600 pixels on its long side, as WebP or JPEG, and never more than a
 * megabyte — so what a visitor downloads is a few hundred kilobytes rather
 * than the twelve megabytes a phone camera writes. It goes straight from the
 * browser to the file store, the same private Blob store the products live
 * in, and is served from an address of ours that never changes for it, so
 * every browser and cache on the way may keep it for a year.
 *
 * The folder a store's pictures live in is its own, derived from the account
 * with a salt of its own. It is not the folder its paid files live in: a
 * picture is public, and its address must never tell anybody where the
 * things that are paid for are kept.
 *
 * Only JPEG and WebP are taken, and what a file is is decided by its first
 * bytes, not by what the upload says. Nothing that can carry a script — SVG
 * included — is ever served from here.
 *
 * The numbers live here, apart from the code that talks to the file store,
 * so the studio can read them in the browser.
 */

/** The most a picture may weigh once the browser has shrunk it. */
export const MAX_IMAGE_BYTES = 1_000_000;

/** The biggest picture the browser is asked to open and shrink. */
export const MAX_SOURCE_BYTES = 30 * 1024 * 1024;

/** The long side, in pixels, a picture is shrunk to when it is bigger. */
export const IMAGE_LONG_SIDE = 1600;

/**
 * The long side of the second, smaller copy made of a picture, for phones.
 *
 * Measured on a store page with one picture on it (PageSpeed, October 5,
 * 2026): the picture was the last thing the phone drew, 3.6 seconds in, and
 * 70% of its bytes were for pixels the phone did not have. A phone of about
 * 400 points across at twice the density draws eight hundred pixels, so that
 * is what the copy holds; a sharper or wider screen still gets the full one.
 * The browser chooses between the two itself (imageSrcSet, below).
 *
 * A picture already this small has no copy: it is its own.
 */
export const SMALL_LONG_SIDE = 800;

/** Long enough to describe a cover to somebody who cannot see it. */
export const MAX_ALT_LENGTH = 150;

/** What may be stored, after shrinking: the browser writes one of these. */
export const IMAGE_CONTENT_TYPES = ["image/webp", "image/jpeg"] as const;

/** What the creator may pick: anything a browser can open and redraw. */
export const IMAGE_ACCEPT = "image/jpeg,image/png,image/webp,image/gif,image/avif";

export type ProductImage = {
  /** Where it sits in the file store: images/<folder>/<id>.<ext>. */
  path: string;
  width: number;
  height: number;
  /** What a screen reader says instead. Empty means a decorative picture. */
  alt: string;
  bytes: number;
  /**
   * The smaller copy for phones, when one was made (SMALL_LONG_SIDE): the
   * same picture in the same shape, so only its width is kept. Null for a
   * picture that is small already, and for every picture from before copies
   * were made — those are shown from the one file, as they always were.
   */
  small: SmallCopy | null;
  /**
   * The picture and its smaller copy are also in the pictures' own R2 bucket (313 [CV1] unit 4b,
   * lib/picture-r2-copy.ts). Absent for every picture copied nowhere; nothing serves from there yet.
   */
  r2?: true;
};

export type SmallCopy = { path: string; width: number; bytes: number };

/** How a product's card is drawn on the store page. */
export const DISPLAY_STYLES = [
  {
    id: "button",
    label: "Button",
    description: "A compact card: the title, the price and the buy button, with a small picture beside the title.",
  },
  {
    id: "callout",
    label: "Callout",
    description: "The picture beside the title, the summary and the price.",
  },
  {
    id: "preview",
    label: "Preview",
    description: "The picture across the whole card, then everything else.",
  },
] as const;

export type DisplayStyle = (typeof DISPLAY_STYLES)[number]["id"];

const STYLE_IDS = new Set<string>(DISPLAY_STYLES.map((style) => style.id));

export function isDisplayStyle(value: unknown): value is DisplayStyle {
  return typeof value === "string" && STYLE_IDS.has(value);
}

/** Every product written before styles existed keeps the card it had. */
export function parseDisplay(raw: unknown): DisplayStyle {
  return isDisplayStyle(raw) ? raw : "button";
}

export const IMAGE_FOLDER_PATTERN = /^[0-9a-f]{24}$/;
export const IMAGE_FILE_PATTERN = /^[0-9a-f]{32}\.(webp|jpg)$/;
const IMAGE_PATH_PATTERN = /^images\/[0-9a-f]{24}\/[0-9a-f]{32}\.(webp|jpg)$/;

/** Where a new picture goes: a fresh id in the store's own picture folder. */
export function imagePath(folder: string, id: string, type: string): string {
  return `images/${folder}/${id}.${type === "image/jpeg" ? "jpg" : "webp"}`;
}

/** Whether a path is a picture in this store's own folder. */
export function ownsImagePath(path: string, folder: string): boolean {
  return IMAGE_PATH_PATTERN.test(path) && path.startsWith(`images/${folder}/`);
}

/** The address a picture is served from. It never changes for a picture. */
export function imageUrl(image: Pick<ProductImage, "path">): string {
  return `/api/image/${image.path.slice("images/".length)}`;
}

/**
 * What to hand the browser so it picks the copy that fits the screen: the
 * two files with the width of each, or nothing when there is only one.
 */
export function imageSrcSet(image: Pick<ProductImage, "path" | "width" | "small">): string | undefined {
  if (!image.small || image.small.width >= image.width) return undefined;
  return `${imageUrl(image.small)} ${image.small.width}w, ${imageUrl(image)} ${image.width}w`;
}

/**
 * How wide each kind of picture is drawn, for the browser to choose by.
 * A card's cover runs the width of the card: the screen less the page's
 * margins, and never more than the column the store page is held to. The
 * product page's own picture sits inside the card's padding as well.
 */
export const IMAGE_SIZES = {
  cover: "(max-width: 36rem) calc(100vw - 2rem), 34rem",
  hero: "(max-width: 42rem) calc(100vw - 4rem), 37rem",
  /** Beside the title, or in a list: a few dozen points across. */
  thumb: "6rem",
} as const;

/** The type a picture is served as, from its own name. */
export function imageType(file: string): "image/webp" | "image/jpeg" {
  return file.endsWith(".jpg") ? "image/jpeg" : "image/webp";
}

/** Whatever came back from storage, made safe to use. */
export function parseProductImage(raw: unknown): ProductImage | null {
  if (!raw || typeof raw !== "object") return null;
  const value = raw as Record<string, unknown>;
  if (typeof value.path !== "string" || !IMAGE_PATH_PATTERN.test(value.path)) return null;
  const side = (n: unknown) => (typeof n === "number" && Number.isInteger(n) && n > 0 && n <= 10_000 ? n : 0);
  const width = side(value.width);
  const height = side(value.height);
  if (!width || !height) return null;
  return {
    path: value.path,
    width,
    height,
    alt: typeof value.alt === "string" ? value.alt.replace(/\s+/g, " ").trim().slice(0, MAX_ALT_LENGTH) : "",
    bytes: typeof value.bytes === "number" && value.bytes > 0 ? value.bytes : 0,
    small: parseSmall(value.small, value.path, width),
    ...(value.r2 === true ? { r2: true as const } : {}),
  };
}

/** The smaller copy as it was stored: in the same folder, and narrower than the picture it is a copy of. */
function parseSmall(raw: unknown, path: string, width: number): SmallCopy | null {
  if (!raw || typeof raw !== "object") return null;
  const value = raw as Record<string, unknown>;
  if (typeof value.path !== "string" || !IMAGE_PATH_PATTERN.test(value.path) || value.path === path) return null;
  if (value.path.slice(0, value.path.lastIndexOf("/")) !== path.slice(0, path.lastIndexOf("/"))) return null;
  const w = typeof value.width === "number" && Number.isInteger(value.width) ? value.width : 0;
  if (w <= 0 || w >= width) return null;
  return { path: value.path, width: w, bytes: typeof value.bytes === "number" && value.bytes > 0 ? value.bytes : 0 };
}

/** Every file a picture is kept in: itself and its smaller copy. For deleting them together. */
export function imagePaths(image: Pick<ProductImage, "path" | "small"> | null | undefined): string[] {
  if (!image) return [];
  return image.small ? [image.path, image.small.path] : [image.path];
}
