/**
 * AX274 Part A, item 5 (PDF/UA, ISO 14289-1 7.21.4.1 and 7.21.7): every font
 * a PDF draws with is embedded and maps its letters back to text. A creator's
 * ebook that meets this must still meet it after the buyer's line is stamped
 * on each page (lib/pdf-stamp.ts): the line was drawn in the standard
 * Helvetica, which is never embedded and has no ToUnicode map, so a stamped
 * copy of a conforming book failed the check. Synthetic file, drawn in the
 * same Noto Sans the site's own PDFs use; nothing is stored or sent.
 */
import fontkit from "@pdf-lib/fontkit";
import { PDFArray, PDFDict, PDFDocument, PDFName } from "pdf-lib";
import { loadFonts } from "@/lib/certificate-pdf";
import { stampPdf } from "@/lib/pdf-stamp";
import { PageTagger } from "@/lib/tagged-pdf";
import { done, is } from "./check";

/** Each font a page draws with: its name, whether its program is in the file and whether it has a ToUnicode map. */
function fontsOn(doc: PDFDocument, index: number): { name: string; embedded: boolean; toUnicode: boolean }[] {
  const fonts = doc.getPages()[index].node.Resources()?.lookupMaybe(PDFName.of("Font"), PDFDict);
  return (fonts?.entries() ?? []).map(([, ref]) => {
    const font = doc.context.lookup(ref, PDFDict);
    const descendants = font.lookupMaybe(PDFName.of("DescendantFonts"), PDFArray);
    const holder = descendants ? doc.context.lookup(descendants.get(0), PDFDict) : font;
    const descriptor = holder.lookupMaybe(PDFName.of("FontDescriptor"), PDFDict);
    return {
      name: String(font.get(PDFName.of("BaseFont"))),
      embedded: !!descriptor && ["FontFile", "FontFile2", "FontFile3"].some((key) => descriptor.has(PDFName.of(key))),
      toUnicode: font.has(PDFName.of("ToUnicode")),
    };
  });
}

async function conformingBook(): Promise<Uint8Array> {
  const pdf = await PDFDocument.create();
  pdf.registerFontkit(fontkit);
  const font = await pdf.embedFont((await loadFonts()).sans, { subset: true });
  const first = pdf.addPage([400, 600]);
  const tagger = new PageTagger(pdf, first);
  tagger.text("H1", () => first.drawText("Chapter one", { x: 40, y: 540, size: 20, font }));
  const second = pdf.addPage([600, 400]);
  second.setRotation({ type: "degrees", angle: 90 } as never);
  tagger.nextPage(second);
  tagger.text("P", () => second.drawText("A page stored sideways.", { x: 40, y: 300, size: 12, font }));
  tagger.finish({ title: "A synthetic book", author: "A creator", producer: "test", lang: "en-US", at: new Date(Date.UTC(2026, 10, 14)) });
  return pdf.save();
}

async function main(): Promise<void> {
  const book = await PDFDocument.load(await conformingBook());
  is("the synthetic book's own fonts are embedded with ToUnicode", [0, 1].map((i) => fontsOn(book, i).every((f) => f.embedded && f.toUnicode)), [true, true]);

  const stamped = await PDFDocument.load(await stampPdf(await conformingBook(), "Sold to maya@example.com on Nov 14, 2026 · order …E54F2A · for personal use"));
  const loose = [0, 1].map((i) => fontsOn(stamped, i).filter((f) => !f.embedded).map((f) => f.name));
  is("after the stamp, every font on every page is embedded (ISO 14289-1 7.21.4.1)", loose, [[], []]);
  is("and maps its letters back to text (7.21.7)", [0, 1].map((i) => fontsOn(stamped, i).every((f) => f.toUnicode)), [true, true]);
  done();
}

void main();
