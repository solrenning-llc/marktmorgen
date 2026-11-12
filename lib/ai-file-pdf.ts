/**
 * A file written with AI and checked by its creator, as a PDF a screen reader
 * can read (758 [STN5] unit 3; PDF/UA, AX274): the title, the store's name,
 * then each part on a page of its own under its heading, its paragraphs in
 * reading order, every page numbered as an artifact a reader skips, and one
 * bookmark for each part. Tagged through lib/tagged-pdf.ts, drawn with the
 * certificate's letters (Noto Sans, lib/certificate-pdf.ts): a file with a
 * letter they do not cover is not made (`fileDrawable`).
 *
 * Headings and paragraphs only in this unit: no lists, tables, pictures or
 * links. Lines hold at most MAX_LINE_CHARS characters at 1.5 line spacing,
 * dark ink on white, so the text reads as 1.4.8 asks of a page.
 */
import { PDFDocument, PDFName, PDFOperator, PDFOperatorNames, type PDFFont, type PDFPage, rgb } from "pdf-lib";
import fontkit from "@pdf-lib/fontkit";
import { PageTagger, addOutline } from "@/lib/tagged-pdf";
import { canDraw, loadFonts } from "@/lib/certificate-pdf";
import { type FileDraft, fileTexts } from "@/lib/ai-file-rules";

const W = 612;
const H = 792;
const MARGIN = 72;
const WIDTH = W - 2 * MARGIN;

/** The most characters on one line of the file. */
export const MAX_LINE_CHARS = 80;

/** Each kind of text: its size in points and the room after it. Line spacing is 1.5 for all. */
export const FILE_STYLE = { H1: { size: 24, gap: 18 }, H2: { size: 16, gap: 12 }, P: { size: 12, gap: 12 } } as const;

/** The lines a paragraph takes: words kept whole, never wider than the page or longer than MAX_LINE_CHARS; a longer word is cut. */
export function wrapLines(font: Pick<PDFFont, "widthOfTextAtSize">, text: string, size: number, width = WIDTH, maxChars = MAX_LINE_CHARS): string[] {
  const fits = (line: string) => Array.from(line).length <= maxChars && font.widthOfTextAtSize(line, size) <= width;
  const out: string[] = [];
  let line = "";
  for (const word of text.split(/\s+/).filter(Boolean)) {
    const tried = line ? `${line} ${word}` : word;
    if (fits(tried)) {
      line = tried;
      continue;
    }
    if (line) out.push(line);
    let rest = word;
    while (!fits(rest)) {
      const chars = Array.from(rest);
      let cut = chars.length - 1;
      while (cut > 1 && !fits(chars.slice(0, cut).join(""))) cut -= 1;
      out.push(chars.slice(0, cut).join(""));
      rest = chars.slice(cut).join("");
    }
    line = rest;
  }
  if (line) out.push(line);
  return out;
}

/** Whether every letter of the file and the store's name can be drawn; when not, no file is made. */
export async function fileDrawable(draft: FileDraft, storeName: string): Promise<boolean> {
  return canDraw(...fileTexts(draft), storeName);
}

export type FileSheet = { draft: FileDraft; storeName: string; lang: string; at: Date };

/** The file as a tagged PDF, US Letter, portrait, each part from a new page. */
export async function filePdf(sheet: FileSheet): Promise<{ bytes: Uint8Array; pages: number }> {
  const loaded = await loadFonts();
  const pdf = await PDFDocument.create();
  pdf.registerFontkit(fontkit);
  const sans = await pdf.embedFont(loaded.sans, { subset: true });
  const semi = await pdf.embedFont(loaded.semi, { subset: true });
  const ink = rgb(0x17 / 255, 0x14 / 255, 0x1f / 255);
  let page: PDFPage = pdf.addPage([W, H]);
  const tag = new PageTagger(pdf, page);
  let y = H - MARGIN;
  const fonts = { H1: semi, H2: semi, P: sans } as const;
  const lead = (role: keyof typeof FILE_STYLE) => FILE_STYLE[role].size * 1.5;
  const turn = () => {
    page = pdf.addPage([W, H]);
    tag.nextPage(page);
    y = H - MARGIN;
  };
  const write = (role: keyof typeof FILE_STYLE, text: string) => {
    const { size, gap } = FILE_STYLE[role];
    const font = fonts[role];
    const lines = wrapLines(font, text, size);
    let from = 0;
    while (from < lines.length) {
      if (y - lead(role) < MARGIN) turn();
      // As many of its lines as this page holds, as one element: read whole on each page, not line by line.
      const room = Math.max(1, Math.floor((y - MARGIN) / lead(role)));
      const chunk = lines.slice(from, from + room);
      const current = page;
      const top = y;
      tag.text(role, () => chunk.forEach((row, i) => current.drawText(row, { x: MARGIN, y: top - lead(role) * (i + 1) + (lead(role) - size) / 2, size, font, color: ink })));
      y -= lead(role) * chunk.length;
      from += chunk.length;
    }
    y -= gap;
  };

  write("H1", sheet.draft.title);
  write("P", sheet.storeName);
  const marks: { title: string; page: PDFPage; top: number }[] = [];
  for (const section of sheet.draft.sections) {
    turn();
    marks.push({ title: section.title, page, top: H });
    write("H2", section.title);
    for (const paragraph of section.body.split("\n\n")) write("P", paragraph);
  }

  // Page numbers, drawn last, as artifacts: a reader skips them and the page order says the same.
  const pages = pdf.getPages();
  pages.forEach((each, i) => {
    each.pushOperators(PDFOperator.of(PDFOperatorNames.BeginMarkedContent, [PDFName.of("Artifact")]));
    each.drawText(`Page ${i + 1} of ${pages.length}`, { x: MARGIN, y: MARGIN / 2, size: 10, font: sans, color: ink });
    each.pushOperators(PDFOperator.of(PDFOperatorNames.EndMarkedContent));
  });
  addOutline(pdf, marks);
  tag.finish({ title: sheet.draft.title, author: sheet.storeName, producer: sheet.storeName, lang: sheet.lang, at: sheet.at });
  return { bytes: await pdf.save(), pages: pages.length };
}
