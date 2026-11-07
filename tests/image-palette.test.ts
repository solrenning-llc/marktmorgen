import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { AppRouterContext } from "next/dist/shared/lib/app-router-context.shared-runtime";
import { LookEditor } from "@/components/look-editor";
import {
  PALETTE_MAX,
  PALETTE_MAX_BYTES,
  PALETTE_MAX_PIXELS,
  PALETTE_SIDE,
  PALETTE_TYPES,
  fitInside,
  paletteFromPixels,
  pictureProblem,
  pictureSize,
  themeForPicture,
  tooManyPixels,
} from "@/lib/image-palette";
import { HEX_PATTERN, isTheme, normaliseHex, parseLook } from "@/lib/store-look";

/** A picture made of solid runs: [hex, pixel count, alpha?]. */
function picture(width: number, height: number, runs: Array<[string, number, number?]>): Uint8ClampedArray {
  const data = new Uint8ClampedArray(width * height * 4);
  let at = 0;
  for (const [hex, count, alpha = 255] of runs) {
    const n = Number.parseInt(hex.slice(1), 16);
    for (let i = 0; i < count; i += 1) {
      data[at] = (n >> 16) & 255;
      data[at + 1] = (n >> 8) & 255;
      data[at + 2] = n & 255;
      data[at + 3] = alpha;
      at += 4;
    }
  }
  assert.equal(at, data.length, "the fixture fills every pixel");
  return data;
}

// One solid colour is read back exactly, as the whole picture.
{
  const result = paletteFromPixels(picture(8, 8, [["#e5533d", 64]]), 8, 8);
  assert.ok(result);
  assert.deepEqual(result.colors.map((c) => c.hex), ["#e5533d"]);
  assert.equal(result.colors[0].share, 1);
  assert.equal(result.dark, false);
}

// A logo on white: the coloured parts come first even though white covers
// most of the picture, so the first choice is a colour that suits a button.
{
  const result = paletteFromPixels(picture(10, 10, [["#ffffff", 70], ["#2f74f5", 20], ["#f59e0b", 10]]), 10, 10);
  assert.ok(result);
  assert.deepEqual(result.colors.map((c) => c.hex), ["#2f74f5", "#f59e0b", "#ffffff"]);
  assert.deepEqual(result.colors.map((c) => c.share), [0.2, 0.1, 0.7]);
  assert.equal(result.dark, false);
  assert.equal(themeForPicture(result), "light");
}

// A dark picture suggests the dark theme; the bright colour still comes first.
{
  const result = paletteFromPixels(picture(10, 10, [["#0b0b10", 85], ["#facc15", 15]]), 10, 10);
  assert.ok(result);
  assert.equal(result.colors[0].hex, "#facc15");
  assert.equal(result.dark, true);
  assert.equal(themeForPicture(result), "night");
  assert.ok(isTheme(themeForPicture(result)), "the suggestion is a real theme");
}

// Colours a reader could not tell apart are one choice, averaged.
{
  const result = paletteFromPixels(picture(4, 4, [["#ff0000", 8], ["#fe0202", 8]]), 4, 4);
  assert.ok(result);
  assert.equal(result.colors.length, 1);
  assert.equal(result.colors[0].share, 1);
}

// Never more than PALETTE_MAX choices, and specks under 1% are not offered.
{
  const hexes = ["#ef4444", "#22c55e", "#3b82f6", "#eab308", "#a855f7", "#14b8a6", "#f97316", "#ec4899"];
  const runs: Array<[string, number]> = hexes.map((hex) => [hex, 12]);
  runs.push(["#000000", 3]); // 3 of 99 pixels, kept; nothing else below 1%
  const result = paletteFromPixels(picture(11, 9, runs), 11, 9);
  assert.ok(result);
  assert.equal(result.colors.length, PALETTE_MAX);
  for (const color of result.colors) {
    assert.match(color.hex, HEX_PATTERN, "every choice is a colour the look accepts");
    assert.equal(normaliseHex(color.hex), color.hex);
  }
  const speck = paletteFromPixels(picture(20, 10, [["#2f74f5", 199], ["#e5533d", 1]]), 20, 10);
  assert.ok(speck);
  assert.deepEqual(speck.colors.map((c) => c.hex), ["#2f74f5"], "one pixel in two hundred is noise, not a colour");
}

// See-through pixels are not part of the picture's colours.
{
  const result = paletteFromPixels(picture(4, 4, [["#15803d", 4], ["#ffffff", 12, 0]]), 4, 4);
  assert.ok(result);
  assert.deepEqual(result.colors.map((c) => c.hex), ["#15803d"]);
  assert.equal(result.colors[0].share, 1);
  assert.equal(paletteFromPixels(picture(4, 4, [["#ffffff", 16, 10]]), 4, 4), null, "a picture with nothing visible has no colours");
}

// Anything that is not exactly a small picture's pixels is refused, never guessed.
{
  const good = picture(2, 2, [["#5a36ee", 4]]);
  assert.equal(paletteFromPixels(good, 2, 3), null, "length must match the size");
  assert.equal(paletteFromPixels(good, 0, 0), null);
  assert.equal(paletteFromPixels(good, 1.5, 2), null);
  assert.equal(paletteFromPixels(new Uint8ClampedArray((PALETTE_SIDE + 1) * 4), PALETTE_SIDE + 1, 1), null, "only the shrunk picture is read");
  assert.equal(paletteFromPixels([255, 0, 0, 300], 1, 1), null, "values outside a byte are refused");
  assert.equal(paletteFromPixels([255, 0, Number.NaN, 255], 1, 1), null);
  assert.equal(paletteFromPixels(null as never, 1, 1), null);
  assert.ok(paletteFromPixels([255, 0, 0, 255], 1, 1), "a plain array of bytes is read too");
}

// The picture is shrunk to fit inside PALETTE_SIDE, keeping its shape.
{
  assert.deepEqual(fitInside(1920, 1080), { width: PALETTE_SIDE, height: 36 });
  assert.deepEqual(fitInside(300, 3000), { width: 6, height: PALETTE_SIDE });
  assert.deepEqual(fitInside(5000, 1), { width: PALETTE_SIDE, height: 1 }, "never squeezed to nothing");
  assert.deepEqual(fitInside(20, 10), { width: 20, height: 10 }, "a small picture is not enlarged");
  assert.equal(fitInside(0, 10), null);
  assert.equal(fitInside(Number.NaN, 10), null);
  assert.equal(fitInside(-4, 10), null);
}

// Only ordinary pictures of a sane size are opened, before anything is decoded.
{
  assert.deepEqual([...PALETTE_TYPES], ["image/png", "image/jpeg", "image/webp"]);
  assert.equal(pictureProblem({ type: "image/png", size: 1024 }), null);
  assert.equal(pictureProblem({ type: "image/jpeg", size: PALETTE_MAX_BYTES }), null);
  assert.equal(pictureProblem({ type: "image/webp", size: PALETTE_MAX_BYTES + 1 }), "too_big");
  assert.equal(pictureProblem({ type: "image/png", size: 0 }), "empty");
  assert.equal(pictureProblem({ type: "image/svg+xml", size: 10 }), "type");
  assert.equal(pictureProblem({ type: "", size: 10 }), "type");
  assert.equal(pictureProblem({ type: "image/png", size: Number.NaN }), "empty");
}

// A picture made only of specks has no colour to offer: null, never an empty list.
{
  const steps = [0, 48, 96, 144, 192, 240];
  const runs: Array<[string, number]> = [];
  for (const r of steps) for (const g of steps) for (const b of steps) {
    runs.push([`#${[r, g, b].map((v) => v.toString(16).padStart(2, "0")).join("")}`, 1]);
  }
  assert.equal(runs.length, 216);
  assert.equal(paletteFromPixels(picture(18, 12, runs), 18, 12), null, "216 specks of 0.46% each are noise");
}

// The size is read from the file's own first bytes before anything is decoded,
// and a picture with too many pixels is refused (a small file can still unpack
// into a huge one).
{
  const bytes = (...parts: Array<number[] | string>) => Uint8Array.from(parts.flatMap((part) => typeof part === "string" ? [...part].map((ch) => ch.charCodeAt(0)) : part));
  const be32 = (n: number) => [(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255];
  const be16 = (n: number) => [(n >> 8) & 255, n & 255];
  const le16 = (n: number) => [n & 255, (n >> 8) & 255];
  const le24 = (n: number) => [n & 255, (n >> 8) & 255, (n >> 16) & 255];

  const png = bytes([0x89], "PNG", [0x0d, 0x0a, 0x1a, 0x0a], be32(13), "IHDR", be32(1920), be32(1080), [8, 6, 0, 0, 0]);
  assert.deepEqual(pictureSize(png), { width: 1920, height: 1080 });
  assert.equal(pictureSize(png.slice(0, 20)), null, "a cut header is not guessed");

  const app0 = [0xff, 0xe0, ...be16(16), ..."JFIF".split("").map((c) => c.charCodeAt(0)), 0, 1, 1, 0, 0, 1, 0, 1, 0, 0];
  const sof2 = [0xff, 0xc2, ...be16(17), 8, ...be16(3000), ...be16(4000), 3, 1, 0x22, 0, 2, 0x11, 1, 3, 0x11, 1];
  assert.deepEqual(pictureSize(bytes([0xff, 0xd8], app0, sof2)), { width: 4000, height: 3000 });
  assert.deepEqual(pictureSize(bytes([0xff, 0xd8, 0xff], app0, sof2)), { width: 4000, height: 3000 }, "fill bytes before a marker are skipped");
  const sos = [0xff, 0xda, ...be16(8), 1, 1, 0, 0, 63, 0];
  assert.equal(pictureSize(bytes([0xff, 0xd8], app0, sos, sof2)), null, "image data before the size means the size is unknown");
  assert.equal(pictureSize(bytes([0xff, 0xd8], app0)), null);

  const vp8 = bytes("RIFF", [0, 0, 0, 0], "WEBP", "VP8 ", [0, 0, 0, 0], [0, 0, 0], [0x9d, 0x01, 0x2a], le16(640), le16(480));
  assert.deepEqual(pictureSize(vp8), { width: 640, height: 480 });
  const w = 1000 - 1;
  const h = 700 - 1;
  const vp8l = bytes("RIFF", [0, 0, 0, 0], "WEBP", "VP8L", [0, 0, 0, 0], [0x2f], [w & 255, ((w >> 8) & 0x3f) | ((h & 3) << 6), (h >> 2) & 255, (h >> 10) & 0x0f]);
  assert.deepEqual(pictureSize(vp8l), { width: 1000, height: 700 });
  const vp8x = bytes("RIFF", [0, 0, 0, 0], "WEBP", "VP8X", [0, 0, 0, 0], [0, 0, 0, 0], le24(16383), le24(8999));
  assert.deepEqual(pictureSize(vp8x), { width: 16384, height: 9000 });

  assert.equal(pictureSize(bytes("<svg xmlns='http://www.w3.org/2000/svg' width='10' height='10'/>")), null, "an SVG named .png is not a picture here");
  assert.equal(pictureSize(new Uint8Array(0)), null);
  assert.equal(pictureSize(bytes([0x89], "PNG", [0x0d, 0x0a, 0x1a, 0x0a], be32(13), "IHDR", be32(0), be32(10))), null, "a zero side is not a size");

  assert.equal(PALETTE_MAX_PIXELS, 40_000_000);
  assert.equal(tooManyPixels({ width: 8000, height: 5000 }), false);
  assert.equal(tooManyPixels({ width: 8000, height: 5001 }), true);
  assert.equal(tooManyPixels({ width: 16384, height: 9000 }), true);
}

// The studio offers it beside the colour, says the picture stays on the
// device, and leaves the existing colour choices exactly as they were.
{
  const html = renderToStaticMarkup(createElement(AppRouterContext.Provider, {
    value: { refresh() {} } as never,
  }, createElement(LookEditor, { look: parseLook({}), photoId: null, name: "Harbor Studio", handle: "harbor" })));
  assert.match(html, /Colors from a picture/);
  assert.match(html, /not uploaded or saved/);
  assert.match(html, /accept="image\/png,image\/jpeg,image\/webp"/);
  assert.match(html, /Choose a picture/);
  const field = html.match(/<fieldset[^>]*><legend[^>]*>Your color<\/legend>([\s\S]*?)<\/fieldset>/)?.[1];
  assert.ok(field);
  assert.doesNotMatch(field, /Colors from a picture/, "the picture is its own group, not a new preset");

  const source = readFileSync("components/look-editor.tsx", "utf8");
  assert.ok(source.indexOf("async function readPicture") > 0, "the reader exists");
  const reader = source.slice(source.indexOf("async function readPicture"), source.indexOf("/** The theme, the colour"));
  assert.ok(reader.length > 0, "the reader is a separate function");
  assert.doesNotMatch(reader, /fetch\(|FormData|toBlob|readAsDataURL/, "the reader never sends or encodes the picture");
  assert.ok(reader.indexOf("pictureSize(") > 0 && reader.indexOf("pictureSize(") < reader.indexOf(".decode()"), "the size is checked before the picture is decoded");
  assert.ok(reader.indexOf("tooManyPixels(") > 0 && reader.indexOf("tooManyPixels(") < reader.indexOf(".decode()"), "too many pixels are refused before decoding");

  // The theme suggestion is said in the same polite live region as the result.
  assert.match(source, /role="status" aria-live="polite"[^>]*>\{pictureNote\}\{pictureSuggestion \? ` \$\{pictureSuggestion\}` : ""\}<\/p>/);

  // A file input hidden inside its label shows focus on the label (2.4.7, 2.4.13):
  // the new picture button and the photo button that was already there.
  const labelOf = (words: string) => {
    const at = html.indexOf(words);
    assert.ok(at > 0, words);
    const start = html.lastIndexOf("<label", at);
    return html.slice(start, html.indexOf(">", start));
  };
  for (const words of ["Choose a picture", "Choose a photo"]) {
    const label = labelOf(words);
    for (const cls of ["has-[:focus-visible]:outline", "has-[:focus-visible]:outline-2", "has-[:focus-visible]:outline-offset-2", "has-[:focus-visible]:outline-violet-brand"]) {
      assert.ok(label.includes(cls), `${words}: ${cls}`);
    }
  }
}

console.log("image-palette: colours, refusals, sizes and the studio block passed");
