/**
 * The demo store's sample PDFs, made readable by a screen reader (AX274 Part
 * A, item 5: every PDF the site hands out follows PDF/UA). The files were
 * first drawn by ReportLab outside the app (lib/demo-file-source.ts keeps
 * them as they were); this redraws each page with pdf-lib, the same words at
 * the same places in the same fonts, and tags it through lib/tagged-pdf.ts:
 *
 * - the title (26pt) is a first-level heading, a bold 13–14pt line a second;
 * - lines that share a baseline are a table row, and rows in a run are a
 *   table: an all-bold first row is its column headers, and the first cell of
 *   every other row heads that row (the day of a meal plan);
 * - a line that starts with "[  ]", "-" or "1." or sits beside a drawn box
 *   is a list item, and a run of them one list;
 * - everything else is a paragraph, and every band, rule, box and write-in
 *   line only decorates (an artifact).
 *
 * Text that read under 7:1 on what is behind it (WCAG 1.4.6) is moved, only
 * as far as it has to, towards black on a light ground or white on a dark
 * one; a stroke under 3:1 on the page (the boxes to tick, the lines to write
 * on, the rules; 1.4.11) is moved towards black. Nothing else changes.
 *
 * Pure and deterministic: the same source gives the same bytes, so the demo
 * store's files keep one path each (lib/demo-seed.ts names them by content).
 * `node scripts/demo-files.mjs` writes the result into lib/demo-file.ts, and
 * tests/ax-pdf-demo-files.test.ts fails when that file is not this output.
 */
import {
  PDFArray,
  PDFDocument,
  type PDFFont,
  type PDFName,
  PDFOperator,
  PDFOperatorNames,
  type PDFPage,
  PDFRawStream,
  type PDFRef,
  PDFString,
  StandardFonts,
  beginText,
  decodePDFRawStream,
  endText,
  moveText,
  popGraphicsState,
  pushGraphicsState,
  rgb,
  setFillingRgbColor,
  setFontAndSize,
} from "pdf-lib";
import { type CellScope, PageTagger, type TagRole } from "@/lib/tagged-pdf";

type Colour = [number, number, number];
type Text = { kind: "text"; x: number; y: number; text: string; font: string; size: number; fill: Colour };
type Op =
  | Text
  | { kind: "fillRect"; x: number; y: number; w: number; h: number; fill: Colour }
  | { kind: "strokeRect"; x: number; y: number; w: number; h: number; stroke: Colour }
  | { kind: "line"; x1: number; y1: number; x2: number; y2: number; stroke: Colour };

/** The fonts the source names, by their resource name. */
const FONTS: Record<string, StandardFonts> = { F1: StandardFonts.Helvetica, F2: StandardFonts.HelveticaBold, F3: StandardFonts.HelveticaOblique };

/** The text contrast asked for (WCAG 1.4.6) and the contrast of a needed graphic (1.4.11). */
export const TEXT_CONTRAST = 7;
export const GRAPHIC_CONTRAST = 3;

function channel(v: number): number {
  return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
}
export function luminance(c: Colour): number {
  return 0.2126 * channel(c[0]) + 0.7152 * channel(c[1]) + 0.0722 * channel(c[2]);
}
export function contrast(a: Colour, b: Colour): number {
  const x = luminance(a);
  const y = luminance(b);
  return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05);
}
const round = (c: Colour): Colour => c.map((v) => Math.round(v * 1000) / 1000) as Colour;

/** The first colour on the way from `c` to black or white (whichever is further from `ground`) that reads at `ratio`. */
export function readable(c: Colour, ground: Colour, ratio: number): Colour {
  if (contrast(c, ground) >= ratio) return c;
  const target: Colour = luminance(ground) > 0.18 ? [0, 0, 0] : [1, 1, 1];
  for (let step = 1; step <= 100; step += 1) {
    const t = step / 100;
    const candidate = round(c.map((v, i) => v + (target[i] - v) * t) as Colour);
    if (contrast(candidate, ground) >= ratio) return candidate;
  }
  return target;
}

function unescape(text: string): string {
  return text.replace(/\\([()\\])/g, "$1");
}

/** The drawing operations of one ReportLab page, in order. Anything it does not know fails, so nothing is dropped unseen. */
export function parsePage(stream: string): Op[] {
  const ops: Op[] = [];
  let fill: Colour = [0, 0, 0];
  let stroke: Colour = [0, 0, 0];
  let font = "F1";
  let size = 12;
  const num = (s: string) => Number(s);
  for (const raw of stream.split("\n")) {
    let line = raw.trim().replace(/^1 0 0 1 0 0 cm\s+/, "");
    if (!line) continue;
    let m: RegExpMatchArray | null;
    if ((m = line.match(/^([\d.]+) ([\d.]+) ([\d.]+) rg$/))) fill = [num(m[1]), num(m[2]), num(m[3])];
    else if ((m = line.match(/^([\d.]+) ([\d.]+) ([\d.]+) RG$/))) stroke = [num(m[1]), num(m[2]), num(m[3])];
    else if ((m = line.match(/^BT \/(F\d) ([\d.]+) Tf [\d.]+ TL ET$/))) {
      font = m[1];
      size = num(m[2]);
    } else if ((m = line.match(/^BT 1 0 0 1 ([\d.]+) ([\d.]+) Tm \((.*)\) Tj T\* ET$/))) {
      const text = unescape(m[3]);
      if (!/^[\x20-\x7e]*$/.test(text)) throw new Error(`demo file: a letter outside plain ASCII in ${JSON.stringify(text.slice(0, 40))}`);
      ops.push({ kind: "text", x: num(m[1]), y: num(m[2]), text, font, size, fill });
    } else if ((m = line.match(/^n ([\d.]+) ([\d.]+) ([\d.]+) ([\d.]+) re f\*$/))) {
      ops.push({ kind: "fillRect", x: num(m[1]), y: num(m[2]), w: num(m[3]), h: num(m[4]), fill });
    } else if ((m = line.match(/^n ([\d.]+) ([\d.]+) ([\d.]+) ([\d.]+) re S$/))) {
      ops.push({ kind: "strokeRect", x: num(m[1]), y: num(m[2]), w: num(m[3]), h: num(m[4]), stroke });
    } else if ((m = line.match(/^n ([\d.]+) ([\d.]+) m ([\d.]+) ([\d.]+) l S$/))) {
      ops.push({ kind: "line", x1: num(m[1]), y1: num(m[2]), x2: num(m[3]), y2: num(m[4]), stroke });
    } else {
      throw new Error(`demo file: an operation this does not know: ${line.slice(0, 80)}`);
    }
  }
  return ops;
}

type Placed =
  | { kind: "leaf"; at: number; role: TagRole; scope?: CellScope }
  | { kind: "table"; rows: { at: number; role: TagRole; scope?: CellScope }[][] }
  | { kind: "list"; items: number[] };

const LIST_MARK = /^(\[\s*\]|-|\d+\.)\s{2}/;

/** What each piece of text is, in reading order (the order it was drawn). */
export function structure(ops: Op[]): Placed[] {
  const texts: { op: Text; at: number; boxed: boolean }[] = [];
  ops.forEach((op, at) => {
    if (op.kind !== "text") return;
    const before = ops[at - 1];
    const boxed = before?.kind === "strokeRect" && before.w === before.h && before.w <= 12;
    texts.push({ op, at, boxed });
  });
  const out: Placed[] = [];
  const heading = (t: Text): TagRole | null => (t.size >= 20 ? "H1" : t.font === "F2" && t.size >= 13 ? "H2" : null);
  let i = 0;
  while (i < texts.length) {
    const t = texts[i];
    const h = heading(t.op);
    if (h) {
      out.push({ kind: "leaf", at: t.at, role: h });
      i += 1;
      continue;
    }
    // A row: the lines from here that share this baseline.
    const rowAt = (from: number) => {
      let to = from;
      while (to < texts.length && !heading(texts[to].op) && texts[to].op.y === texts[from].op.y) to += 1;
      return to - from;
    };
    if (rowAt(i) >= 2) {
      const width = rowAt(i);
      const rows: (typeof texts)[] = [];
      while (i < texts.length && rowAt(i) === width) {
        rows.push(texts.slice(i, i + width));
        i += width;
      }
      const headerRow = rows.length > 1 && rows[0].every((cell) => cell.op.font === "F2");
      out.push({
        kind: "table",
        rows: rows.map((row, r) =>
          row.map((cell, c) =>
            headerRow && r === 0
              ? { at: cell.at, role: "TH" as TagRole, scope: "Column" as CellScope }
              : c === 0
                ? { at: cell.at, role: "TH" as TagRole, scope: "Row" as CellScope }
                : { at: cell.at, role: "TD" as TagRole },
          ),
        ),
      });
      continue;
    }
    const item = (k: number) => k < texts.length && (LIST_MARK.test(texts[k].op.text) || texts[k].boxed) && rowAt(k) === 1 && !heading(texts[k].op);
    if (item(i)) {
      const items: number[] = [];
      while (item(i)) items.push(texts[i++].at);
      out.push({ kind: "list", items });
      continue;
    }
    out.push({ kind: "leaf", at: t.at, role: "P" });
    i += 1;
  }
  // Paragraphs drawn one after another are read top to bottom, as seen (WCAG
  // 1.3.2): the footer was drawn from its lower line up.
  const top = (p: Placed) => (p.kind === "leaf" && p.role === "P" ? (ops[p.at] as Text).y : null);
  for (let from = 0; from < out.length; ) {
    let to = from;
    while (to < out.length && top(out[to]) !== null) to += 1;
    if (to - from > 1) out.splice(from, to - from, ...out.slice(from, to).sort((a, b) => top(b)! - top(a)!));
    from = Math.max(to, from + 1);
  }
  return out;
}

/** What is behind a point: the last band drawn over it, or the white page. */
function groundAt(ops: Op[], upTo: number, x: number, y: number): Colour {
  for (let k = upTo - 1; k >= 0; k -= 1) {
    const op = ops[k];
    if (op.kind === "fillRect" && x >= op.x && x <= op.x + op.w && y >= op.y && y <= op.y + op.h) return op.fill;
  }
  return [1, 1, 1];
}

/** The source's pages: each one's size and its drawing, as text. */
async function readSource(source: Uint8Array): Promise<{ title: string; author: string; pages: { width: number; height: number; stream: string }[] }> {
  const doc = await PDFDocument.load(source, { updateMetadata: false });
  const pages = doc.getPages().map((page) => {
    const raw = page.node.Contents();
    const refs = raw instanceof PDFArray ? raw.asArray() : raw ? [raw] : [];
    const stream = refs
      .map((ref) => {
        const found = doc.context.lookup(ref as PDFRef);
        if (!(found instanceof PDFRawStream)) throw new Error("demo file: a page whose drawing cannot be read");
        return new TextDecoder("latin1").decode(decodePDFRawStream(found).decode());
      })
      .join("\n");
    return { ...page.getSize(), stream };
  });
  const title = doc.getTitle();
  const author = doc.getAuthor();
  if (!title || !author) throw new Error("demo file: a source with no title or author");
  return { title, author, pages };
}

/** One source PDF, redrawn and tagged. */
export async function tagDemoFile(source: Uint8Array): Promise<Uint8Array> {
  const read = await readSource(source);
  const pdf = await PDFDocument.create({ updateMetadata: false });
  const fonts = new Map<string, PDFFont>();
  for (const [name, standard] of Object.entries(FONTS)) fonts.set(name, await pdf.embedFont(standard));
  let tagger: PageTagger | null = null;
  read.pages.forEach((source) => {
    const ops = parsePage(source.stream);
    const page: PDFPage = pdf.addPage([source.width, source.height]);
    if (!tagger) tagger = new PageTagger(pdf, page);
    else tagger.nextPage(page);
    const tag: PageTagger = tagger;
    const colour = (c: Colour) => rgb(c[0], c[1], c[2]);
    const white: Colour = [1, 1, 1];
    // Decoration first, in the order drawn, so bands sit under their words.
    ops.forEach((op) => {
      if (op.kind === "fillRect") tag.artifact(() => page.drawRectangle({ x: op.x, y: op.y, width: op.w, height: op.h, color: colour(op.fill) }));
      else if (op.kind === "strokeRect")
        tag.artifact(() => page.drawRectangle({ x: op.x, y: op.y, width: op.w, height: op.h, borderColor: colour(readable(op.stroke, white, GRAPHIC_CONTRAST)), borderWidth: 1 }));
      else if (op.kind === "line")
        tag.artifact(() => page.drawLine({ start: { x: op.x1, y: op.y1 }, end: { x: op.x2, y: op.y2 }, thickness: 1, color: colour(readable(op.stroke, white, GRAPHIC_CONTRAST)) }));
    });
    // Each font named once in the page's resources.
    const keys = new Map<string, PDFName>();
    const keyOf = (name: string) => {
      const font = fonts.get(name)!;
      if (!keys.has(name)) keys.set(name, page.node.newFontDictionary(font.name, font.ref));
      return keys.get(name)!;
    };
    // The words as a plain string, as the source wrote them (every letter is
    // ASCII, checked above), so the file can be searched for what it says.
    const draw = (at: number) => () => {
      const op = ops[at] as Text;
      const fill = readable(op.fill, groundAt(ops, at, op.x, op.y), TEXT_CONTRAST);
      page.pushOperators(
        pushGraphicsState(),
        beginText(),
        setFillingRgbColor(fill[0], fill[1], fill[2]),
        setFontAndSize(keyOf(op.font), op.size),
        moveText(op.x, op.y),
        PDFOperator.of(PDFOperatorNames.ShowText, [PDFString.of(op.text.replace(/[\\()]/g, (c) => `\\${c}`))]),
        endText(),
        popGraphicsState(),
      );
    };
    for (const placed of structure(ops)) {
      if (placed.kind === "leaf") tag.text(placed.role, draw(placed.at));
      else if (placed.kind === "list") tag.group("L", () => placed.items.forEach((at) => tag.group("LI", () => tag.text("LBody", draw(at)))));
      else
        tag.group("Table", () =>
          placed.rows.forEach((row) => tag.group("TR", () => row.forEach((cell) => tag.text(cell.role, draw(cell.at), undefined, cell.scope ? { scope: cell.scope } : undefined)))),
        );
    }
  });
  if (!tagger) throw new Error("demo file: no page");
  (tagger as PageTagger).finish({ title: read.title, author: read.author, producer: read.author, lang: "en-US", at: new Date(Date.UTC(2026, 9, 1)) });
  return pdf.save();
}

/** The text of lib/demo-file.ts: every source redrawn and tagged, as base64 lines, and `getDemoFile`. */
export async function demoFileModule(): Promise<string> {
  const { DEMO_SOURCE_FILES, demoSource } = await import("@/lib/demo-file-source");
  const names = Object.keys(DEMO_SOURCE_FILES) as (keyof typeof DEMO_SOURCE_FILES)[];
  const lines: string[] = [
    "// The demo store's sample PDFs, the files a buyer of it is handed: tagged",
    "// for a screen reader (PDF/UA), embedded so they ship with the server",
    "// function and are never exposed as public static files.",
    "// Written by `node scripts/demo-files.mjs` from lib/demo-file-source.ts",
    "// through lib/demo-file-build.ts; do not edit by hand.",
    "const FILES = {",
  ];
  for (const name of names) {
    const base64 = Buffer.from(await tagDemoFile(demoSource(name))).toString("base64");
    lines.push(`  ${JSON.stringify(name)}: [`);
    for (let at = 0; at < base64.length; at += 100) lines.push(`    ${JSON.stringify(base64.slice(at, at + 100))},`);
    lines.push("  ],");
  }
  lines.push(
    "} as const;",
    "",
    "export type DemoFileName = keyof typeof FILES;",
    "",
    "export function getDemoFile(name: DemoFileName): Uint8Array {",
    '  return Uint8Array.from(Buffer.from(FILES[name].join(""), "base64"));',
    "}",
    "",
  );
  return lines.join("\n");
}
