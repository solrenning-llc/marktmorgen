/**
 * The main colours of a picture the creator picks from their own device, such
 * as their logo or a screenshot of their brand (386 [TB12], unit 1).
 *
 * The studio draws the picture small on a canvas in the creator's browser and
 * hands the pixels here; only the colours found are kept. The picture is never
 * uploaded, saved or sent, so there is no storage, no request and no supplier
 * cost. Choosing one of the colours only sets the look's accent in the editor:
 * nothing is saved until the creator saves the look, and the page still paints
 * the accent through lookColours (lib/store-look.ts), which moves it as far as
 * needed for the contrast a reader needs.
 *
 * Nothing in this file touches the network, the store or the DOM, so it runs
 * the same in a test as in the browser. Anything that is not exactly a small
 * picture's pixels is refused (null), never guessed.
 */

import type { ThemeId } from "@/lib/store-look";

/** The picture is shrunk to fit inside this many pixels a side before it is read. */
export const PALETTE_SIDE = 64;
/** At most this many colours are offered. */
export const PALETTE_MAX = 5;
/** A colour covering less than this share of the visible picture is a speck, not a colour. */
export const PALETTE_MIN_SHARE = 0.01;
/** Pictures larger than this are not opened at all. */
export const PALETTE_MAX_BYTES = 15 * 1024 * 1024;
/**
 * Pictures with more pixels than this are not decoded: a small file can unpack
 * into a huge picture, so the size is read from the file's own header first.
 */
export const PALETTE_MAX_PIXELS = 40_000_000;
/** How much of the start of a file is read to find its size. */
export const PALETTE_HEAD_BYTES = 256 * 1024;
/** The only kinds of picture opened: ordinary photos and images, never SVG. */
export const PALETTE_TYPES = ["image/png", "image/jpeg", "image/webp"] as const;

/** Two colours closer than this (straight-line distance in RGB) are one choice. */
const MERGE_DISTANCE = 48;
/** A colour whose channels differ by at least this much is colourful rather than grey. */
const VIVID_SPREAD = 48;
/** A pixel at least this opaque is part of the picture. */
const VISIBLE_ALPHA = 128;
/** The luminance of a mid grey (#767676): a picture darker than it on average is dark. */
const DARK_LUMINANCE = 0.18;

export type PictureColor = {
  /** Lower-case #rrggbb, which normaliseHex and the look accept as they are. */
  hex: string;
  /** The share of the visible picture it covers, 0 to 1, to three places. */
  share: number;
};

export type PicturePalette = {
  /** Colourful ones first, each group from the largest share down. */
  colors: PictureColor[];
  /** Whether the visible picture is darker than mid grey on average. */
  dark: boolean;
};

export type PictureProblem = "type" | "empty" | "too_big";

/** Why a file cannot be opened, before anything is decoded; null when it can. */
export function pictureProblem(file: { type: string; size: number }): PictureProblem | null {
  if (!(PALETTE_TYPES as readonly string[]).includes(file.type)) return "type";
  if (!(Number.isFinite(file.size) && file.size > 0)) return "empty";
  if (file.size > PALETTE_MAX_BYTES) return "too_big";
  return null;
}

export type PictureSize = { width: number; height: number };

function ascii(bytes: Uint8Array, at: number, text: string): boolean {
  if (at + text.length > bytes.length) return false;
  for (let i = 0; i < text.length; i += 1) if (bytes[at + i] !== text.charCodeAt(i)) return false;
  return true;
}

function sized(width: number, height: number): PictureSize | null {
  return Number.isInteger(width) && Number.isInteger(height) && width > 0 && height > 0 ? { width, height } : null;
}

/** JPEG markers that start a frame and carry its size (SOF0–SOF15 but DHT, JPG and DAC). */
const JPEG_FRAMES = new Set([0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf]);

function jpegSize(bytes: Uint8Array): PictureSize | null {
  let at = 2;
  while (at < bytes.length) {
    if (bytes[at] !== 0xff) return null;
    while (at < bytes.length && bytes[at] === 0xff) at += 1;
    if (at >= bytes.length) return null;
    const marker = bytes[at];
    at += 1;
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd8)) continue;
    // Image data or the end before any size: the size is unknown.
    if (marker === 0xda || marker === 0xd9) return null;
    if (at + 2 > bytes.length) return null;
    const length = (bytes[at] << 8) | bytes[at + 1];
    if (length < 2) return null;
    if (JPEG_FRAMES.has(marker)) {
      if (at + 7 > bytes.length) return null;
      return sized((bytes[at + 5] << 8) | bytes[at + 6], (bytes[at + 3] << 8) | bytes[at + 4]);
    }
    at += length;
  }
  return null;
}

function webpSize(bytes: Uint8Array): PictureSize | null {
  if (ascii(bytes, 12, "VP8 ")) {
    if (bytes.length < 30 || bytes[23] !== 0x9d || bytes[24] !== 0x01 || bytes[25] !== 0x2a) return null;
    return sized((bytes[26] | (bytes[27] << 8)) & 0x3fff, (bytes[28] | (bytes[29] << 8)) & 0x3fff);
  }
  if (ascii(bytes, 12, "VP8L")) {
    if (bytes.length < 25 || bytes[20] !== 0x2f) return null;
    const [b0, b1, b2, b3] = [bytes[21], bytes[22], bytes[23], bytes[24]];
    return sized(1 + (b0 | ((b1 & 0x3f) << 8)), 1 + ((b1 >> 6) | (b2 << 2) | ((b3 & 0x0f) << 10)));
  }
  if (ascii(bytes, 12, "VP8X")) {
    if (bytes.length < 30) return null;
    return sized(1 + (bytes[24] | (bytes[25] << 8) | (bytes[26] << 16)), 1 + (bytes[27] | (bytes[28] << 8) | (bytes[29] << 16)));
  }
  return null;
}

/**
 * A picture's width and height from the first bytes of the file itself (its
 * PNG, JPEG or WebP header), whatever type the file claims, so nothing has to
 * be decoded to know it. Null when the bytes are none of the three or the
 * size cannot be found in them: then the picture is not opened.
 */
export function pictureSize(head: Uint8Array): PictureSize | null {
  if (!(head instanceof Uint8Array)) return null;
  if (head.length >= 24 && head[0] === 0x89 && ascii(head, 1, "PNG") && head[4] === 0x0d && head[5] === 0x0a && head[6] === 0x1a && head[7] === 0x0a && ascii(head, 12, "IHDR")) {
    const read = (at: number) => ((head[at] << 24) >>> 0) + (head[at + 1] << 16) + (head[at + 2] << 8) + head[at + 3];
    return sized(read(16), read(20));
  }
  if (head.length >= 4 && head[0] === 0xff && head[1] === 0xd8) return jpegSize(head);
  if (ascii(head, 0, "RIFF") && ascii(head, 8, "WEBP")) return webpSize(head);
  return null;
}

/** Whether a picture has more pixels than PALETTE_MAX_PIXELS. */
export function tooManyPixels(size: PictureSize): boolean {
  return size.width * size.height > PALETTE_MAX_PIXELS;
}

/** The size to draw a picture at so it fits inside PALETTE_SIDE, keeping its shape and never enlarging it. */
export function fitInside(width: number, height: number): { width: number; height: number } | null {
  if (!(Number.isFinite(width) && Number.isFinite(height) && width > 0 && height > 0)) return null;
  const scale = Math.min(1, PALETTE_SIDE / Math.max(width, height));
  return {
    width: Math.min(PALETTE_SIDE, Math.max(1, Math.round(width * scale))),
    height: Math.min(PALETTE_SIDE, Math.max(1, Math.round(height * scale))),
  };
}

function channelLight(value: number): number {
  const c = value / 255;
  return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
}

/** The WCAG relative luminance of one pixel, the same formula lib/store-look.ts uses. */
function luminance(r: number, g: number, b: number): number {
  return 0.2126 * channelLight(r) + 0.7152 * channelLight(g) + 0.0722 * channelLight(b);
}

function hexOf(r: number, g: number, b: number): string {
  return `#${[r, g, b].map((v) => Math.round(v).toString(16).padStart(2, "0")).join("")}`;
}

type Group = { r: number; g: number; b: number; count: number };

function average(group: Group): [number, number, number] {
  return [group.r / group.count, group.g / group.count, group.b / group.count];
}

/**
 * The main colours of a picture from its RGBA pixels (as a canvas gives them),
 * width × height, at most PALETTE_SIDE a side. Null when the input is not
 * exactly that, when no pixel is visible, or when every colour is a speck.
 */
export function paletteFromPixels(data: ArrayLike<number>, width: number, height: number): PicturePalette | null {
  if (!data || typeof data.length !== "number") return null;
  if (!Number.isInteger(width) || !Number.isInteger(height)) return null;
  if (width < 1 || height < 1 || width > PALETTE_SIDE || height > PALETTE_SIDE) return null;
  if (data.length !== width * height * 4) return null;
  for (let i = 0; i < data.length; i += 1) {
    const value = data[i];
    if (!Number.isInteger(value) || value < 0 || value > 255) return null;
  }

  // Close shades share a bucket (16 steps a channel), so a photo's thousands
  // of near-identical pixels become a handful of candidates.
  const buckets = new Map<number, Group>();
  let visible = 0;
  let light = 0;
  for (let i = 0; i < data.length; i += 4) {
    if (data[i + 3] < VISIBLE_ALPHA) continue;
    const r = data[i];
    const g = data[i + 1];
    const b = data[i + 2];
    visible += 1;
    light += luminance(r, g, b);
    const key = ((r >> 4) << 8) | ((g >> 4) << 4) | (b >> 4);
    const bucket = buckets.get(key);
    if (bucket) {
      bucket.r += r;
      bucket.g += g;
      bucket.b += b;
      bucket.count += 1;
    } else {
      buckets.set(key, { r, g, b, count: 1 });
    }
  }
  if (visible === 0) return null;

  // Largest buckets first; a bucket a reader could not tell from a group
  // already found joins it, so one colour is never offered twice.
  const ordered = [...buckets.entries()].sort((a, b) => b[1].count - a[1].count || a[0] - b[0]).map(([, group]) => group);
  const groups: Group[] = [];
  for (const bucket of ordered) {
    const [r, g, b] = average(bucket);
    const near = groups.find((group) => {
      const [gr, gg, gb] = average(group);
      return Math.hypot(r - gr, g - gg, b - gb) < MERGE_DISTANCE;
    });
    if (near) {
      near.r += bucket.r;
      near.g += bucket.g;
      near.b += bucket.b;
      near.count += bucket.count;
    } else {
      groups.push({ ...bucket });
    }
  }

  const found = groups
    .filter((group) => group.count / visible >= PALETTE_MIN_SHARE)
    .map((group) => {
      const [r, g, b] = average(group);
      const vivid = Math.max(r, g, b) - Math.min(r, g, b) >= VIVID_SPREAD;
      return { hex: hexOf(r, g, b), share: Math.round((group.count / visible) * 1000) / 1000, count: group.count, vivid };
    })
    // A logo on white is mostly white, but its colour is what suits a button.
    .sort((a, b) => Number(b.vivid) - Number(a.vivid) || b.count - a.count);

  // Only specks: there is no colour to offer, which is "none found", not an empty choice.
  if (found.length === 0) return null;

  return {
    colors: found.slice(0, PALETTE_MAX).map(({ hex, share }) => ({ hex, share })),
    dark: light / visible < DARK_LUMINANCE,
  };
}

/** The theme a picture's own lightness suggests: Night for a dark one, Paper otherwise. */
export function themeForPicture(palette: PicturePalette): ThemeId {
  return palette.dark ? "night" : "light";
}
