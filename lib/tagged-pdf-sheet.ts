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

/** The lines a paragraph takes at this size and width: words kept whole, a word longer than the width cut where it must be. */
export function wrap(font: Pick<PDFFont, "widthOfTextAtSize">, text: string, size: number, width: number): string[] {
  const out: string[] = [];
  for (const paragraph of text.split("\n")) {
    let line = "";
    for (const word of paragraph.split(/\s+/).filter(Boolean)) {
      const tried = line ? `${line} ${word}` : word;
      if (font.widthOfTextAtSize(tried, size) <= width) {
        line = tried;
        continue;
      }
      if (line) out.push(line);
      // A word wider than the line is cut into pieces that fit.
      let rest = word;
      while (font.widthOfTextAtSize(rest, size) > width) {
        let cut = Array.from(rest).length - 1;
        while (cut > 1 && font.widthOfTextAtSize(Array.from(rest).slice(0, cut).join(""), size) > width) cut -= 1;
        out.push(Array.from(rest).slice(0, cut).join(""));
        rest = Array.from(rest).slice(cut).join("");
      }
      line = rest;
    }
    out.push(line);
  }
  return out;
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
    const lines = wrap(font, text, size, WIDTH);
    let from = 0;
    while (from < lines.length) {
      if (y - lead(role) < MARGIN) turn();
      // As many of its lines as this page holds, as one element: a paragraph is read whole, not line by line.
      const room = Math.max(1, Math.floor((y - MARGIN) / lead(role)));
      const chunk = lines.slice(from, from + room);
      const current = page;
      const top = y;
      tag.text(role, () => chunk.forEach((line, i) => current.drawText(line, { x: MARGIN, y: top - lead(role) * (i + 1), size, font, color: ink })));
      y -= lead(role) * chunk.length;
      from += chunk.length;
    }
    y -= gap;
  });
  tag.finish({ title: meta.title, author: meta.author, producer: meta.producer, lang: meta.lang, at: new Date() });
  return pdf.save();
}
