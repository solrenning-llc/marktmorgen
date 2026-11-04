/**
 * A certificate of completion as a PDF file (added 11 October 2026), next to
 * the page it already was (app/[handle]/certificate/[id]).
 *
 * The page printed or saved as a PDF from the browser, which depends on the
 * browser, its print settings and the student knowing where "Save as PDF" is.
 * This draws the same sheet as a file: US Letter, landscape, the store's
 * color, the student's name, the course, who taught it and when, and the
 * certificate's id with the address that checks it. Everything on it is read
 * from the record kept when it was issued (lib/certificate.ts), so the file
 * says exactly what the page says.
 *
 * The letters are Noto Sans and Noto Serif (SIL Open Font License, lib/fonts),
 * cut down to Latin, Greek and Cyrillic (with Vietnamese) when they were
 * added, so a name in Polish, Czech, Turkish, Greek or Russian is spelled
 * right. A name in a script they do not cover —
 * Chinese, Arabic, Hindi — is not drawn as empty boxes: canDraw says no, and
 * the page, which the browser draws with its own fonts, is the certificate.
 *
 * Read aloud as well as seen (630 [HN6](8), unit 1): the file is tagged
 * (lib/tagged-pdf.ts) with a heading and paragraphs in reading order, the
 * frame, rule and seal marked as decoration, its language and title set, and
 * the PDF/UA identification in its metadata. Every line of text is at least
 * 7:1 against the paper (WCAG 1.4.6): the store's color is darkened for the
 * store's name only as far as it must be, and kept as it is for the frame.
 *
 * In the store's own look (630 [HN6](8), unit 2; owner's choice through
 * C3-23, 3 November 2026): its letters choose the headings' face (a serif
 * for Editorial and Elegant, the sans for the others), its backdrop is drawn
 * as a fine pattern in the band between the two frames only, where no text
 * is, so every line still sits on the paper at 7:1, and the seal carries the
 * store's initial (lib/store-app.ts, monogram) in white or ink, whichever
 * reads better on its color. No picture is uploaded for it: a logo and a
 * signature of the creator's own are a later unit of the same item.
 */
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { PDFDocument, type PDFFont, type PDFPage, degrees, rgb } from "pdf-lib";
import fontkit from "@pdf-lib/fontkit";
import { PageTagger } from "@/lib/tagged-pdf";
import { type BackdropId, type FontId, contrast, mix } from "@/lib/store-look";

const W = 792;
const H = 612;

/**
 * What one file costs to draw, in its store's public requests, all taken
 * before it is drawn (app/[handle]/certificate/[id]/pdf/route.ts): one
 * before the certificate is read, the rest before the file is made. Measured
 * on 4 November 2026 at 81 ms of CPU and 107 KB a file, at most 0.56 s cold
 * and 146 KB with the longest words in every look; priced at a second of
 * CPU, four seconds held and CERTIFICATE_PDF_MAX_BYTES sent, which
 * tests/plan-cost-registry.test.ts holds these requests above.
 */
export const CERTIFICATE_PDF_UNITS = 2;
/** The most one file weighs, with room over the heaviest measured (tests/certificate-pdf-ceiling.test.ts draws it). */
export const CERTIFICATE_PDF_MAX_BYTES = 256_000;

type Fonts = { sans: Uint8Array; semi: Uint8Array; serif: Uint8Array };
let fonts: Promise<Fonts> | null = null;

/** The three faces, read once per server. */
export function loadFonts(): Promise<Fonts> {
  // Each path written out whole, so the deployment's file tracing sees them
  // (next.config.ts lists the folder too).
  fonts ??= Promise.all([
    readFile(join(process.cwd(), "lib/fonts/NotoSans-Regular.ttf")),
    readFile(join(process.cwd(), "lib/fonts/NotoSans-SemiBold.ttf")),
    readFile(join(process.cwd(), "lib/fonts/NotoSerif-Bold.ttf")),
  ]).then(([sans, semi, serif]) => ({ sans: new Uint8Array(sans), semi: new Uint8Array(semi), serif: new Uint8Array(serif) }));
  return fonts;
}

/** Whether every letter of these words is in the faces the file is drawn with. */
let faces: Promise<ReturnType<typeof fontkit.create>[]> | null = null;

export async function canDraw(...texts: string[]): Promise<boolean> {
  faces ??= loadFonts().then((loaded) => [loaded.sans, loaded.serif].map((bytes) => fontkit.create(bytes as unknown as Buffer)));
  const read = await faces;
  return texts.every((text) =>
    Array.from(text).every((char) => {
      const code = char.codePointAt(0) ?? 0;
      return code < 32 || read.every((face) => face.hasGlyphForCodePoint(code));
    }),
  );
}

export type CertificateSheet = {
  name: string;
  title: string;
  storeName: string;
  /** The words around them, in the store's language (lib/buyer-words/courses.ts). */
  kicker: string;
  certifies: string;
  hasCompleted: string;
  taughtBy: string;
  idLine: string;
  checkLine: string;
  /** "Sample", across the sheet, for the creator's preview; empty on a real one. */
  stamp: string;
  /** The store's color, #rrggbb. */
  accent: string;
  /** The store's language, as a BCP 47 tag ("en", "pt"): what a screen reader reads it in. */
  lang: string;
  /** The store's letters and backdrop (lib/store-look.ts); left out, the sheet as it was. */
  look?: { font: FontId; backdrop: BackdropId };
  /** The store's initial for the seal; left out or not drawable, the check mark. */
  monogram?: string;
};

/** The face of the headings (the kind of certificate and the student's name) for the store's letters. */
export function headingFace(font: FontId | undefined): "serif" | "sans" {
  return font === undefined || font === "editorial" || font === "elegant" ? "serif" : "sans";
}

/** White or ink, whichever reads better on the store's color: the monogram's ink. */
export function monogramInk(accent: string): string {
  const fill = hexOf(accent);
  return contrast("#ffffff", fill) >= contrast(INK, fill) ? "#ffffff" : INK;
}

/** The band between the outer and inner frame, where the backdrop is drawn: nothing in it is text. */
export const BAND = { outer: 30, inner: 38 + 26 } as const;

/** The shapes of a backdrop in the band, as plain numbers (drawn below, counted in tests/certificate-look.test.ts). */
export function bandShapes(backdrop: BackdropId | undefined): { dots: { x: number; y: number }[]; lines: { x1: number; y1: number; x2: number; y2: number }[]; washes: { x: number; y: number; w: number; h: number; opacity: number }[] } {
  const dots: { x: number; y: number }[] = [];
  const lines: { x1: number; y1: number; x2: number; y2: number }[] = [];
  const washes: { x: number; y: number; w: number; h: number; opacity: number }[] = [];
  const a = 42;
  const b = BAND.inner - 4;
  const inBand = (x: number, y: number) => x >= a && x <= W - a && y >= a && y <= H - a && (x < b || x > W - b || y < b || y > H - b);
  if (backdrop === "dots") {
    for (let x = a; x <= W - a; x += 9) for (let y = a; y <= H - a; y += 9) if (inBand(x, y)) dots.push({ x, y });
  } else if (backdrop === "grid") {
    for (let x = a; x <= W - a; x += 12) {
      lines.push({ x1: x, y1: a, x2: x, y2: b }, { x1: x, y1: H - b, x2: x, y2: H - a });
    }
    for (let y = a; y <= H - a; y += 12) {
      lines.push({ x1: a, y1: y, x2: b, y2: y }, { x1: W - b, y1: y, x2: W - a, y2: y });
    }
    for (const y of [a, b, H - b, H - a]) lines.push({ x1: a, y1: y, x2: W - a, y2: y });
  } else if (backdrop === "glow" || backdrop === "aurora") {
    // A wash of the color in the band, strongest at the top (glow) or all round (aurora).
    const top = { x: a, y: H - b, w: W - 2 * a, h: b - a };
    washes.push({ ...top, opacity: backdrop === "glow" ? 0.18 : 0.12 });
    if (backdrop === "aurora") {
      washes.push({ x: a, y: a, w: W - 2 * a, h: b - a, opacity: 0.12 }, { x: a, y: b, w: b - a, h: H - 2 * b, opacity: 0.08 }, { x: W - b, y: b, w: b - a, h: H - 2 * b, opacity: 0.08 });
    }
  }
  return { dots, lines, washes };
}

/** The paper, the ink and the softer ink the sheet is printed with. */
export const PAPER = "#fdfcfa";
export const INK = "#17141f";
const SOFT = "#5c5a6b";
/** The contrast every line of text keeps against the paper (WCAG 1.4.6). */
export const TEXT_CONTRAST = 7;

function hexOf(raw: string): string {
  return /^#[0-9a-f]{6}$/i.test(raw) ? raw.toLowerCase() : "#5a36ee";
}

/** `hex` moved toward the ink only as far as it takes to read at 7:1 on the paper. */
export function readableInk(hex: string): string {
  const start = hexOf(hex);
  for (let step = 0; step <= 50; step += 1) {
    const candidate = mix(start, INK, step / 50);
    if (contrast(candidate, PAPER) >= TEXT_CONTRAST) return candidate;
  }
  return INK;
}

function color(hex: string) {
  const value = hexOf(hex);
  return rgb(parseInt(value.slice(1, 3), 16) / 255, parseInt(value.slice(3, 5), 16) / 255, parseInt(value.slice(5, 7), 16) / 255);
}

/** The largest size from `max` down at which `text` fits `width`, never under `min`. */
function fit(font: PDFFont, text: string, max: number, min: number, width: number): number {
  for (let size = max; size > min; size -= 1) if (font.widthOfTextAtSize(text, size) <= width) return size;
  return min;
}

/** One line, centered, shortened with an ellipsis if even the smallest size is too wide. Returns the line drawn. */
function centered(page: PDFPage, font: PDFFont, text: string, y: number, max: number, min: number, ink: ReturnType<typeof rgb>, width = W - 200): string {
  const size = fit(font, text, max, min, width);
  let line = text;
  while (line.length > 1 && font.widthOfTextAtSize(line, size) > width) line = `${Array.from(line).slice(0, -2).join("")}…`;
  page.drawText(line, { x: (W - font.widthOfTextAtSize(line, size)) / 2, y, size, font, color: ink });
  return line;
}

/**
 * The certificate, drawn as a one-page PDF. `at` is the file's creation date
 * (its metadata); the same sheet at the same moment makes the same file, so a
 * test that compares two files gives both the same moment.
 */
export async function certificatePdf(sheet: CertificateSheet, at: Date = new Date()): Promise<Uint8Array> {
  const loaded = await loadFonts();
  const pdf = await PDFDocument.create();
  pdf.registerFontkit(fontkit);
  const sans = await pdf.embedFont(loaded.sans, { subset: true });
  const semi = await pdf.embedFont(loaded.semi, { subset: true });
  // Embedded whole: cut to the letters this sheet uses, its glyphs come out
  // blank (pdf-lib's subsetting and this face disagree), and whole it is
  // already reduced to Latin, Greek and Cyrillic, about 160 KB.
  const serif = await pdf.embedFont(loaded.serif, { subset: false });
  const page = pdf.addPage([W, H]);
  const tag = new PageTagger(pdf, page);
  const accent = color(sheet.accent);
  const accentText = color(readableInk(sheet.accent));
  const ink = color(INK);
  const soft = color(readableInk(SOFT));
  /** A centered line read as `role`; a shortened one is read in full. */
  const say = (role: "H1" | "P", font: PDFFont, text: string, y: number, max: number, min: number, shade: ReturnType<typeof rgb>) => {
    let drawn = text;
    tag.text(role, () => {
      drawn = centered(page, font, text, y, max, min, shade);
    });
    if (drawn !== text) tag.retext(text);
  };

  tag.artifact(() => {
    page.drawRectangle({ x: 0, y: 0, width: W, height: H, color: color(PAPER) });
    page.drawRectangle({ x: 24, y: 24, width: W - 48, height: H - 48, borderColor: accent, borderWidth: 6 });
    page.drawRectangle({ x: 38, y: 38, width: W - 76, height: H - 76, borderColor: accent, borderWidth: 1, opacity: 0, borderOpacity: 0.6 });
  });

  // The store's backdrop, in the band between the frames only: decoration, never under a line of text.
  const shapes = bandShapes(sheet.look?.backdrop);
  if (shapes.dots.length || shapes.lines.length || shapes.washes.length) {
    tag.artifact(() => {
      for (const wash of shapes.washes) page.drawRectangle({ x: wash.x, y: wash.y, width: wash.w, height: wash.h, color: accent, opacity: wash.opacity });
      for (const dot of shapes.dots) page.drawCircle({ x: dot.x, y: dot.y, size: 0.9, color: accent, opacity: 0.45 });
      for (const line of shapes.lines) page.drawLine({ start: { x: line.x1, y: line.y1 }, end: { x: line.x2, y: line.y2 }, thickness: 0.4, color: accent, opacity: 0.35 });
    });
  }

  const head = headingFace(sheet.look?.font) === "serif" ? serif : semi;
  say("P", semi, sheet.storeName.toLocaleUpperCase(), H - 92, 13, 9, accentText);
  say("H1", head, sheet.kicker, H - 150, 34, 22, ink);
  say("P", sans, sheet.certifies, H - 205, 14, 10, soft);
  say("P", head, sheet.name, H - 265, 44, 22, ink);
  tag.artifact(() => {
    page.drawLine({ start: { x: W / 2 - 150, y: H - 282 }, end: { x: W / 2 + 150, y: H - 282 }, thickness: 1, color: accent });
  });
  say("P", sans, sheet.hasCompleted, H - 318, 14, 10, soft);
  say("P", semi, sheet.title, H - 360, 26, 13, ink);
  say("P", sans, sheet.taughtBy, H - 396, 13, 9, soft);

  // The seal: a ring in the store's color with the store's initial, or a check
  // mark drawn as two strokes. It only decorates: the store's name is read above.
  const cx = 120;
  const cy = 108;
  const mark = color(monogramInk(sheet.accent));
  const initial = sheet.monogram && Array.from(sheet.monogram).length === 1 && (await canDraw(sheet.monogram)) ? sheet.monogram : "";
  tag.artifact(() => {
    page.drawCircle({ x: cx, y: cy, size: 34, color: accent });
    page.drawCircle({ x: cx, y: cy, size: 27, borderColor: mark, borderWidth: 1.5, opacity: 0 });
    if (initial) {
      const size = 28;
      const width = semi.widthOfTextAtSize(initial, size);
      page.drawText(initial, { x: cx - width / 2, y: cy - size * 0.36, size, font: semi, color: mark });
    } else {
      page.drawLine({ start: { x: cx - 12, y: cy }, end: { x: cx - 3, y: cy - 10 }, thickness: 4, color: mark });
      page.drawLine({ start: { x: cx - 3, y: cy - 10 }, end: { x: cx + 14, y: cy + 11 }, thickness: 4, color: mark });
    }
  });

  const proofSize = 9.5;
  tag.text("P", () => page.drawText(sheet.idLine, { x: W - 70 - sans.widthOfTextAtSize(sheet.idLine, proofSize), y: 112, size: proofSize, font: sans, color: soft }));
  tag.text("P", () => page.drawText(sheet.checkLine, { x: W - 70 - sans.widthOfTextAtSize(sheet.checkLine, proofSize), y: 96, size: proofSize, font: sans, color: soft }));

  if (sheet.stamp) {
    // Faint across the sheet, for the eye only: the ID line, at full contrast, already says no student was issued this one.
    const size = 120;
    const width = semi.widthOfTextAtSize(sheet.stamp, size);
    tag.artifact(() => page.drawText(sheet.stamp, { x: (W - width * 0.8) / 2, y: H / 2 - 120, size, font: semi, color: accent, opacity: 0.12, rotate: degrees(20) }));
  }
  tag.finish({ title: `${sheet.kicker} — ${sheet.name}`, author: sheet.storeName, producer: sheet.storeName, lang: sheet.lang, at });
  return pdf.save();
}
