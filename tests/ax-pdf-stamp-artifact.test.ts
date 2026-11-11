/**
 * AX274 Part A, item 5 (PDF/UA, ISO 14289-1 7.1): in a tagged PDF, everything
 * drawn is either part of the structure tree or marked as an artifact. A
 * creator's tagged ebook must stay that way after the buyer's line is stamped
 * on each page (lib/pdf-stamp.ts): the line is an ownership mark along the
 * foot of the page, like a running footer or watermark, so it is drawn as an
 * artifact and a screen reader keeps reading only the book. Synthetic file;
 * nothing is stored or sent.
 */
import { PDFArray, PDFDict, PDFDocument, PDFName, PDFRawStream, type PDFRef, StandardFonts, decodePDFRawStream } from "pdf-lib";
import { stampPdf } from "@/lib/pdf-stamp";
import { PageTagger } from "@/lib/tagged-pdf";
import { done, is } from "./check";

function content(doc: PDFDocument, index: number): string {
  const raw = doc.getPages()[index].node.Contents();
  const refs = raw instanceof PDFArray ? raw.asArray() : [raw];
  return refs
    .map((ref) => {
      const stream = doc.context.lookup(ref as PDFRef);
      return stream instanceof PDFRawStream ? new TextDecoder("latin1").decode(decodePDFRawStream(stream).decode()) : "";
    })
    .join("\n");
}

/** Every text-showing operator, by where it sits: in a tagged element, in an artifact, or loose. */
function textPlaces(stream: string): { tagged: number; artifact: number; loose: number } {
  const counts = { tagged: 0, artifact: 0, loose: 0 };
  const open: string[] = [];
  for (const raw of stream.split("\n")) {
    const line = raw.trim();
    if (/BDC$/.test(line)) open.push(/^\/Artifact\b/.test(line) ? "artifact" : "tag");
    else if (/^\/Artifact BMC$/.test(line)) open.push("artifact");
    else if (/BMC$/.test(line)) open.push("other");
    else if (/^EMC$/.test(line)) open.pop();
    if (/(Tj|TJ|'|")$/.test(line)) {
      const where = open[open.length - 1];
      if (where === "tag") counts.tagged += 1;
      else if (where === "artifact") counts.artifact += 1;
      else counts.loose += 1;
    }
  }
  return counts;
}

async function taggedBook(): Promise<Uint8Array> {
  const pdf = await PDFDocument.create();
  const font = await pdf.embedFont(StandardFonts.Helvetica);
  const first = pdf.addPage([400, 600]);
  const tagger = new PageTagger(pdf, first);
  tagger.text("H1", () => first.drawText("Chapter one", { x: 40, y: 540, size: 20, font }));
  tagger.text("P", () => first.drawText("The first page of a synthetic book.", { x: 40, y: 500, size: 12, font }));
  const second = pdf.addPage([600, 400]);
  second.setRotation({ type: "degrees", angle: 90 } as never);
  tagger.nextPage(second);
  tagger.text("P", () => second.drawText("A page stored sideways.", { x: 40, y: 300, size: 12, font }));
  tagger.finish({ title: "A synthetic book", author: "A creator", producer: "test", lang: "en-US", at: new Date(Date.UTC(2026, 10, 11)) });
  return pdf.save();
}

async function main(): Promise<void> {
  const book = await taggedBook();
  const before = await PDFDocument.load(book);
  is("the synthetic book starts with no loose text", [0, 1].map((i) => textPlaces(content(before, i)).loose), [0, 0]);

  const stamped = await PDFDocument.load(await stampPdf(book, "Sold to maya@example.com on Nov 11, 2026 · order E54F2A"));
  const pages = [0, 1].map((i) => textPlaces(content(stamped, i)));
  is("the buyer's line adds no loose text to any page (ISO 14289-1 7.1)", pages.map((p) => p.loose), [0, 0]);
  is("the buyer's line is drawn as an artifact on every page", pages.map((p) => p.artifact >= 1), [true, true]);
  is("the book's own text stays tagged", pages.map((p) => p.tagged), [2, 1]);
  is("the structure tree, language and marking survive the stamp", [
    stamped.catalog.get(PDFName.of("StructTreeRoot")) !== undefined,
    stamped.catalog.lookup(PDFName.of("MarkInfo"), PDFDict).get(PDFName.of("Marked"))?.toString(),
    stamped.catalog.get(PDFName.of("Lang"))?.toString(),
  ], [true, "true", "(en-US)"]);
  done();
}

void main();
