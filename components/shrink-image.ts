"use client";

import { IMAGE_LONG_SIDE, MAX_IMAGE_BYTES, toneOf } from "@/lib/product-image";

/**
 * Shrinks a picture in the browser: never more than `longSide` on its long
 * side (IMAGE_LONG_SIDE unless told otherwise) and never more than a
 * megabyte (or `maxBytes`), keeping its shape. WebP where the browser can write it, JPEG
 * where it cannot, or always when asked. Also used for the picture on a community post
 * (components/community-composer.tsx).
 */
export async function shrink(
  file: File,
  longSide: number = IMAGE_LONG_SIDE,
  maxBytes: number = MAX_IMAGE_BYTES,
  /** JPEG whatever the browser can write: for a picture in an email, which Outlook on Windows shows only so. */
  jpegOnly = false,
): Promise<{ blob: Blob; width: number; height: number; tone: string | null }> {
  const url = URL.createObjectURL(file);
  try {
    const image = new Image();
    image.decoding = "async";
    image.src = url;
    await image.decode();
    const w = image.naturalWidth;
    const h = image.naturalHeight;
    if (!w || !h) throw new Error("unreadable");

    let scale = Math.min(1, longSide / Math.max(w, h));
    for (let attempt = 0; attempt < 4; attempt += 1) {
      const width = Math.max(1, Math.round(w * scale));
      const height = Math.max(1, Math.round(h * scale));
      const canvas = document.createElement("canvas");
      canvas.width = width;
      canvas.height = height;
      const context = canvas.getContext("2d");
      if (!context) throw new Error("unreadable");
      context.imageSmoothingQuality = "high";
      context.drawImage(image, 0, 0, width, height);

      const encode = (type: string, quality: number) =>
        new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, type, quality));
      let quality = 0.86;
      let blob = jpegOnly ? null : await encode("image/webp", quality);
      let type = "image/webp";
      // Older Safari cannot write WebP and quietly hands back a PNG instead.
      if (!blob || blob.type !== "image/webp") {
        // JPEG has no transparency: paint white behind the picture first.
        context.globalCompositeOperation = "destination-over";
        context.fillStyle = "#ffffff";
        context.fillRect(0, 0, width, height);
        type = "image/jpeg";
        blob = await encode(type, quality);
      }
      while (blob && blob.size > maxBytes && quality > 0.5) {
        quality -= 0.12;
        blob = await encode(type, quality);
      }
      if (blob && blob.size <= maxBytes) return { blob, width, height, tone: sampleTone(canvas) };
      scale *= 0.75;
    }
    throw new Error("too_big");
  } finally {
    URL.revokeObjectURL(url);
  }
}

/**
 * The picture's average color, from every pixel of the canvas it was drawn on (lib/product-image.ts, toneOf): null
 * for a picture with any transparency, even one pixel (a sample shrunk to a few pixels would average it away; Codex
 * K2 on #2790), or where the browser will not read the canvas back.
 */
function sampleTone(source: HTMLCanvasElement): string | null {
  try {
    const context = source.getContext("2d");
    if (!context) return null;
    return toneOf(context.getImageData(0, 0, source.width, source.height).data);
  } catch {
    return null;
  }
}
