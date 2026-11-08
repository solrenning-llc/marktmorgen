/**
 * One answer to a form as a PDF a screen reader can read (639 [GL7](26),
 * unit 2; PDF/UA, AX274): for the creator to keep or print an application.
 * The form's name is the heading; each question is a heading of its own with
 * the answer under it, in the order asked; then the result, the score and
 * whether they asked to hear from the creator, as the studio shows them.
 * Tagged through lib/tagged-pdf.ts, over as many pages as it takes.
 *
 * The letters are the certificate's (Noto Sans, lib/certificate-pdf.ts); an
 * answer in a script they do not cover is not drawn as boxes: `canDraw` says
 * no and the studio's list and spreadsheet stay the way to read it.
 */
import { PDFDocument, type PDFFont, type PDFPage, rgb } from "pdf-lib";
import fontkit from "@pdf-lib/fontkit";
import { PageTagger } from "@/lib/tagged-pdf";
import { canDraw, loadFonts } from "@/lib/certificate-pdf";
import { answerText, isScored, type Answers, type FormDef, type FormField, type FormResponse } from "@/lib/forms";

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

export type ResponseSheet = { form: FormDef; response: FormResponse; storeName: string; sentLine: string; lang: string };

function responseAnswerText(field: FormField, given: Answers[string] | undefined): string {
  const text = answerText(field, given);
  if (field.type === "choice" || field.type === "choices") {
    const saved = Array.isArray(given) ? given : typeof given === "string" && given !== "" ? [given] : [];
    if (saved.some(id => !field.options.some(option => option.id === id))) {
      const warning = "One or more saved choices are no longer listed in the current form.";
      return text ? `${text}\n${warning}` : warning;
    }
  }
  return text || "No answer.";
}

/** The texts the file would draw, in order: what `canDraw` is asked about before anything is made. */
export function responseTexts(sheet: ResponseSheet): { role: "H1" | "H2" | "P"; text: string }[] {
  const { form, response } = sheet;
  const out: { role: "H1" | "H2" | "P"; text: string }[] = [{ role: "H1", text: form.name }, { role: "P", text: sheet.sentLine }];
  for (const field of form.fields) {
    out.push({ role: "H2", text: field.label }, { role: "P", text: responseAnswerText(field, response.answers[field.id]) });
  }
  const outcome = form.outcomes.find((o) => o.id === response.outcome);
  if (outcome) out.push({ role: "H2", text: "Result" }, { role: "P", text: outcome.title });
  if (isScored(form) && typeof response.score === "number") out.push({ role: "H2", text: "Score" }, { role: "P", text: String(response.score) });
  out.push({ role: "H2", text: "Asked to hear from you by email" }, { role: "P", text: response.joined ? "Yes" : "No" });
  return out;
}

/** Whether every letter can be drawn; when not, no file is made. */
export async function responseDrawable(sheet: ResponseSheet): Promise<boolean> {
  return canDraw(...responseTexts(sheet).map((t) => t.text), sheet.storeName);
}

/** The answer as a tagged PDF, US Letter, portrait, as many pages as it takes. */
export async function responsePdf(sheet: ResponseSheet): Promise<Uint8Array> {
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
  const texts = responseTexts(sheet);
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
  tag.finish({ title: `${sheet.form.name} — ${sheet.sentLine}`, author: sheet.storeName, producer: sheet.storeName, lang: sheet.lang, at: new Date() });
  return pdf.save();
}
