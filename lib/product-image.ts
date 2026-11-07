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

/**
 * A third copy, for a small picture in a list (56 px wide, at most 2x that on a sharp screen): about this long on its
 * long side, made in the creator's browser like the smaller copy (Encanto 5b-2), and never more than this many bytes.
 */
export const THUMB_LONG_SIDE = 240;
export const MAX_THUMB_BYTES = 40_000;

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
   * The thumbnail copy (THUMB_LONG_SIDE, at most MAX_THUMB_BYTES), when one was made (Encanto 5b-2): narrower than the
   * smaller copy, in the same folder. Absent for every picture from before; those are served as they were.
   */
  thumb?: SmallCopy;
  /**
   * The picture and its smaller copy are also in the pictures' own R2 bucket (313 [CV1] unit 4b,
   * lib/picture-r2-copy.ts). Absent for every picture copied nowhere; nothing serves from there yet.
   */
  r2?: true;
  /**
   * The picture's average color, exactly #rrggbb (TONE_PATTERN), painted under it while it loads (Encanto 5b): made
   * in the creator's browser from the picture as it is shrunk, only for a picture with no transparency. Absent for
   * every picture from before, and for one that has transparency.
   */
  tone?: string;
};

/** A picture's color as it is kept: # and six lowercase hex digits, nothing else. */
export const TONE_PATTERN = /^#[0-9a-f]{6}$/;

/**
 * The average color of a picture's pixels (RGBA, four bytes each, as canvas getImageData gives them), as #rrggbb;
 * null where any pixel is not fully opaque (the color would show through once the picture loads), where there is
 * nothing to read, or where the bytes are not whole pixels.
 */
export function toneOf(data: ArrayLike<number>): string | null {
  if (data.length === 0 || data.length % 4 !== 0) return null;
  let r = 0;
  let g = 0;
  let b = 0;
  for (let i = 0; i < data.length; i += 4) {
    if (data[i + 3] !== 255) return null;
    r += data[i];
    g += data[i + 1];
    b += data[i + 2];
  }
  const pixels = data.length / 4;
  const hex = (sum: number) => Math.round(sum / pixels).toString(16).padStart(2, "0");
  return `#${hex(r)}${hex(g)}${hex(b)}`;
}

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
export function imageSrcSet(image: Pick<ProductImage, "path" | "width" | "small"> & { thumb?: SmallCopy | null }): string | undefined {
  const copies = smallerCopies(image);
  return copies.length ? [...copies, { path: image.path, width: image.width }].map((copy) => `${imageUrl(copy)} ${copy.width}w`).join(", ") : undefined;
}

/**
 * A picture's smaller copies, narrowest first: the thumbnail copy (Encanto 5b-2) and the smaller copy, each only
 * when it is narrower than the next one up. Empty for a picture with neither, which is served from the one file.
 */
export function smallerCopies(image: Pick<ProductImage, "width" | "small"> & { thumb?: SmallCopy | null }): SmallCopy[] {
  const small = image.small && image.small.width < image.width ? image.small : null;
  const thumb = image.thumb && image.thumb.width < (small ? small.width : image.width) ? image.thumb : null;
  return [...(thumb ? [thumb] : []), ...(small ? [small] : [])];
}

/**
 * How wide each kind of picture is drawn, for the browser to choose by.
 * A card's cover runs the width of the card: the screen less the page's
 * margins, and never more than the column the store page is held to. The
 * product page's own picture sits inside the card's padding as well.
 */
export const IMAGE_SIZES = {
  cover: "(max-width: 36rem) calc(100vw - 2rem), 34rem",
  /**
   * A card in the store page's grid: from 1024 px the cards go two to a row beside the store's profile (Encanto 3),
   * each at most about 25rem wide. Only that grid; a one-column list keeps `cover` (Codex K2 on #2786).
   */
  grid: "(min-width: 64rem) 25rem, (max-width: 36rem) calc(100vw - 2rem), 34rem",
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
  const small = parseSmall(value.small, value.path, width);
  const thumb = parseThumb(value.thumb, value.path, width, small);
  return {
    path: value.path,
    width,
    height,
    alt: typeof value.alt === "string" ? value.alt.replace(/\s+/g, " ").trim().slice(0, MAX_ALT_LENGTH) : "",
    bytes: typeof value.bytes === "number" && value.bytes > 0 ? value.bytes : 0,
    small,
    ...(thumb ? { thumb } : {}),
    ...(value.r2 === true ? { r2: true as const } : {}),
    ...(typeof value.tone === "string" && TONE_PATTERN.test(value.tone) ? { tone: value.tone } : {}),
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

/**
 * The thumbnail copy as it was stored: in the same folder, neither the picture nor its smaller copy, narrower than
 * the smaller copy (or the picture, without one), and within MAX_THUMB_BYTES. Anything else is dropped.
 */
function parseThumb(raw: unknown, path: string, width: number, small: SmallCopy | null): SmallCopy | null {
  if (!raw || typeof raw !== "object") return null;
  const value = raw as Record<string, unknown>;
  if (typeof value.path !== "string" || !IMAGE_PATH_PATTERN.test(value.path) || value.path === path || value.path === small?.path) return null;
  if (value.path.slice(0, value.path.lastIndexOf("/")) !== path.slice(0, path.lastIndexOf("/"))) return null;
  const w = typeof value.width === "number" && Number.isInteger(value.width) ? value.width : 0;
  if (w <= 0 || w >= (small ? small.width : width)) return null;
  const bytes = typeof value.bytes === "number" && Number.isInteger(value.bytes) ? value.bytes : 0;
  if (bytes <= 0 || bytes > MAX_THUMB_BYTES) return null;
  return { path: value.path, width: w, bytes };
}

/**
 * The checked size of each file a record shows, by name. A product's or a link's record is written only after every
 * file in it passed the checks of app/api/store/image or app/api/store/link-image (the file store's own size and type,
 * and its first bytes), so a name it shows, sent again and not fresh from the picture door, needs no new read
 * (C1-20261107-1550-TODOS-10). A size that is not a whole number from 1 to MAX_IMAGE_BYTES, or a name the record gives
 * two sizes, is left out, and that file is checked again: unknown is never taken as checked (rule 24).
 */
export function checkedSizes(
  image: { path: string; bytes: number; small?: SmallCopy | null; thumb?: SmallCopy | null } | null | undefined,
): Map<string, number> {
  const sizes = new Map<string, number>();
  const doubtful = new Set<string>();
  const note = (file: { path: unknown; bytes: unknown } | null | undefined) => {
    if (!file || typeof file.path !== "string" || !file.path) return;
    const bytes = file.bytes;
    const good = typeof bytes === "number" && Number.isInteger(bytes) && bytes > 0 && bytes <= MAX_IMAGE_BYTES;
    if (!good || (sizes.has(file.path) && sizes.get(file.path) !== bytes)) doubtful.add(file.path);
    else sizes.set(file.path, bytes);
  };
  note(image);
  note(image?.small);
  note(image?.thumb);
  for (const path of doubtful) sizes.delete(path);
  return sizes;
}

/** Every file a picture is kept in: itself, its smaller copy and its thumbnail copy. For deleting them together. */
export function imagePaths(image: (Pick<ProductImage, "path" | "small"> & { thumb?: SmallCopy | null }) | null | undefined): string[] {
  if (!image) return [];
  return [image.path, ...(image.small ? [image.small.path] : []), ...(image.thumb ? [image.thumb.path] : [])];
}
