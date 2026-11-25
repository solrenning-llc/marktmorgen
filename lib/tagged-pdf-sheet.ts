/**
 * A tagged PDF of headings and paragraphs, US Letter, portrait, over as many pages as it takes (PDF/UA through
 * lib/tagged-pdf.ts, AX274): the layout first written for one answer to a form (lib/form-response-pdf.ts, 639
 * [GL7](26)), shared with the first product a creator makes in the studio (lib/first-product-pdf.ts, 490 [PP1]).
 * The letters are the certificate's (Noto Sans, lib/certificate-pdf.ts); a caller checks with `canDraw` first.
 */
import { PDFDocument, type PDFFont, type PDFPage, rgb } from "pdf-lib";
import fontkit from "@pdf-lib/fontkit";
import { PageTagger } from "@/lib/tagged-pdf";
import { loadFonts } from "@/lib/certificate-pdf";

const W = 612;
const H = 792;
const MARGIN = 72;
const WIDTH = W - 2 * MARGIN;
// A visual-only work bound. It matches FIRST_PRODUCT_LONG_WORD without inserting separators into source text.
const LAYOUT_WORD_CHARS = 40;

/**
 * The lines a paragraph takes at this size and width: words kept whole, a word longer than the width cut where it
 * must be. Each word is measured once and the line's width is the sum of its words and spaces, so the work grows
 * with the text, never with the text times the line (independent review of 490 [PP1], 12 November 2026).
 */
type WrappedLine = { draw: string; actual: string; replace: boolean };

function wrappedText(font: Pick<PDFFont, "widthOfTextAtSize">, text: string, size: number, width: number): WrappedLine[] {
  const out: WrappedLine[] = [];
  const space = font.widthOfTextAtSize(" ", size);
  for (const [paragraphAt, paragraph] of text.split("\n").entries()) {
    let line = "";
    let lineWidth = 0;
    let actual = "";
    let replace = false;
    let consumed = 0;
    let first = true;
    const words = [...paragraph.matchAll(/\S+/g)];
    if (!words.length) {
      out.push({ draw: "", actual: `${paragraphAt ? "\n" : ""}${paragraph}`, replace: false });
      continue;
    }
    for (const found of words) {
      const originalWord = found[0];
      const originalBefore = `${first && paragraphAt ? "\n" : ""}${paragraph.slice(consumed, found.index)}`;
      first = false;
      consumed = found.index + originalWord.length;
      const letters = Array.from(originalWord);
      const visualWords = Array.from({ length: Math.ceil(letters.length / LAYOUT_WORD_CHARS) }, (_, at) => letters.slice(at * LAYOUT_WORD_CHARS, (at + 1) * LAYOUT_WORD_CHARS).join(""));
      for (const [visualAt, word] of visualWords.entries()) {
        const before = visualAt ? "" : originalBefore;
        const splitForWork = visualWords.length > 1;
        const wordWidth = font.widthOfTextAtSize(word, size);
        const tried = line ? lineWidth + (before ? space : 0) + wordWidth : wordWidth;
        if (tried <= width) {
          line = line ? `${line}${before ? " " : ""}${word}` : word;
          lineWidth = tried;
          actual += before + word;
          replace ||= splitForWork;
          continue;
        }
        if (line) out.push({ draw: line, actual, replace });
        // A word wider than the line is cut into pieces that fit.
        let rest = word;
        let restWidth = wordWidth;
        let wordPrefix = before;
        while (restWidth > width) {
          const letters = Array.from(rest);
          // Find the widest fitting prefix in logarithmic probes. Walking back from the end makes a long pasted
          // token quadratic; the PDF request is costed on linear/bounded layout work.
          let low = 1;
          let high = letters.length - 1;
          while (low < high) {
            const middle = Math.ceil((low + high) / 2);
            if (font.widthOfTextAtSize(letters.slice(0, middle).join(""), size) <= width) low = middle;
            else high = middle - 1;
          }
          const cut = low;
          const piece = letters.slice(0, cut).join("");
          out.push({ draw: piece, actual: wordPrefix + piece, replace: true });
          wordPrefix = "";
          rest = letters.slice(cut).join("");
          restWidth = font.widthOfTextAtSize(rest, size);
        }
        line = rest;
        lineWidth = restWidth;
        actual = wordPrefix + rest;
        replace = splitForWork || wordWidth > width;
      }
    }
    actual += paragraph.slice(consumed);
    out.push({ draw: line, actual, replace });
  }
  return out;
}

export function wrap(font: Pick<PDFFont, "widthOfTextAtSize">, text: string, size: number, width: number): string[] {
  return wrappedText(font, text, size, width).map((line) => line.draw);
}

/** One piece of a sheet: a title (H1), a heading (H2) or a paragraph (P), in reading order. */
export type SheetText = { role: "H1" | "H2" | "P"; text: string };

/** The texts as a tagged PDF; `meta` names the file (its title, who made it, its language). */
export async function taggedSheetPdf(texts: SheetText[], meta: { title: string; author: string; producer: string; lang: string }): Promise<Uint8Array> {
  const loaded = await loadFonts();
  const pdf = await PDFDocument.create();
  pdf.registerFontkit(fontkit);
  const sans = await pdf.embedFont(loaded.sans, { subset: true });
  const semi = await pdf.embedFont(loaded.semi, { subset: true });
  const ink = rgb(0x17 / 255, 0x14 / 255, 0x1f / 255);
  let page: PDFPage = pdf.addPage([W, H]);
  const tag = new PageTagger(pdf, page);
  const paper = (p: PDFPage) => tag.artifact(() => p.drawRectangle({ x: 0, y: 0, width: W, height: H, color: rgb(0xfd / 255, 0xfc / 255, 0xfa / 255) }));
  paper(page);
  let y = H - MARGIN;
  const style = { H1: { font: semi, size: 20, gap: 14 }, H2: { font: semi, size: 12, gap: 4 }, P: { font: sans, size: 11, gap: 12 } } as const;
  const lead = (role: keyof typeof style) => style[role].size * 1.5;
  const turn = () => {
    page = pdf.addPage([W, H]);
    tag.nextPage(page);
    paper(page);
    y = H - MARGIN;
  };
  texts.forEach(({ role, text }, at) => {
    const { font, size, gap } = style[role];
    // A heading is never left alone at the foot of a page: it moves on with the first line of what follows.
    const next = texts[at + 1];
    if (role !== "P" && next && y - lead(role) - lead(next.role) < MARGIN) turn();
    const lines = wrappedText(font, text, size, WIDTH);
    let from = 0;
    while (from < lines.length) {
      if (y - lead(role) < MARGIN) turn();
      // As many of its lines as this page holds, as one element: a paragraph is read whole, not line by line.
      const room = Math.max(1, Math.floor((y - MARGIN) / lead(role)));
      const chunk = lines.slice(from, from + room);
      const current = page;
      const top = y;
      // Visual wrapping may split one unbroken token across lines. ActualText keeps the element's source text
      // exact for copy, search and assistive technology instead of exposing inferred spaces or line breaks.
      tag.text(
        role,
        () => chunk.forEach((line, i) => current.drawText(line.draw, { x: MARGIN, y: top - lead(role) * (i + 1), size, font, color: ink })),
        chunk.some((line) => line.replace) ? chunk.map((line) => line.actual).join("") : undefined,
      );
      y -= lead(role) * chunk.length;
      from += chunk.length;
    }
    y -= gap;
  });
  tag.finish({ title: meta.title, author: meta.author, producer: meta.producer, lang: meta.lang, at: new Date() });
  return pdf.save();
}
