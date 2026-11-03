/**
 * 630 [HN6](8) unit 2: the certificate file in the store's own look — its
 * letters, its backdrop in the band between the frames only, and its initial
 * in the seal — with every line of text still on the paper at 7:1 and the
 * file still tagged for screen readers.
 */
import { PDFArray, PDFDict, PDFDocument, PDFName, PDFRawStream, type PDFRef, decodePDFRawStream } from "pdf-lib";
import { BAND, INK, PAPER, TEXT_CONTRAST, bandShapes, certificatePdf, headingFace, monogramInk, readableInk } from "@/lib/certificate-pdf";
import { BACKDROPS, FONTS, contrast } from "@/lib/store-look";
import { done, is, part } from "./check";

const W = 792;
const H = 612;
const sheet = {
  name: "Ana Souza",
  title: "Knife Skills",
  storeName: "Harbor Kitchen",
  kicker: "Certificate of completion",
  certifies: "This certifies that",
  hasCompleted: "has completed",
  taughtBy: "taught by Harbor Kitchen, on November 3, 2026",
  idLine: "Certificate ID abcdefgh12345678",
  checkLine: "Check it at marktmorgen.com/@harbor/certificate/abcdefgh12345678",
  stamp: "",
  accent: "#5a36ee",
  lang: "en",
};

/** The page's drawing operators, decoded (as tests/tagged-pdf.test.ts reads them). */
function content(doc: PDFDocument): string {
  const raw = doc.getPages()[0].node.Contents();
  const refs = raw instanceof PDFArray ? raw.asArray() : [raw];
  return refs.map((ref) => {
    const stream = doc.context.lookup(ref as PDFRef);
    return stream instanceof PDFRawStream ? new TextDecoder("latin1").decode(decodePDFRawStream(stream).decode()) : "";
  }).join("\n");
}

async function main(): Promise<void> {
  part("The store's letters");
  is("a serif for Editorial and Elegant, the sans for the others", FONTS.map((f) => [f.id, headingFace(f.id)]), [["modern", "sans"], ["editorial", "serif"], ["elegant", "serif"], ["friendly", "sans"], ["bold", "sans"]]);
  is("without a look, the sheet as it was (serif)", headingFace(undefined), "serif");

  part("The store's backdrop, in the band only");
  is("plain draws nothing", bandShapes("plain"), { dots: [], lines: [], washes: [] });
  const inner = { x1: BAND.inner, y1: BAND.inner, x2: W - BAND.inner, y2: H - BAND.inner };
  const outside = (x: number, y: number) => x < inner.x1 || x > inner.x2 || y < inner.y1 || y > inner.y2;
  for (const { id } of BACKDROPS.filter((b) => b.id !== "plain")) {
    const s = bandShapes(id);
    is(`${id}: something is drawn`, s.dots.length + s.lines.length + s.washes.length > 0, true);
    const points = [...s.dots, ...s.lines.flatMap((l) => [{ x: l.x1, y: l.y1 }, { x: l.x2, y: l.y2 }]), ...s.washes.flatMap((w) => [{ x: w.x, y: w.y }, { x: w.x + w.w, y: w.y + w.h }])];
    is(`${id}: every shape lies in the band, where no text is`, points.every((p) => p.x >= 30 && p.y >= 30 && p.x <= W - 30 && p.y <= H - 30) && s.dots.every((d) => outside(d.x, d.y)) && s.washes.every((w) => w.x + w.w <= inner.x1 || w.x >= inner.x2 || w.y + w.h <= inner.y1 || w.y >= inner.y2), true);
  }
  is("the lowest line of text (the check line, y 96, right edge 722) is inside the band's edge", 96 > BAND.inner && W - 70 < W - BAND.inner, true);

  part("Every line still at 7:1 on the paper");
  for (const accent of ["#5a36ee", "#ffd400", "#00c2a8", "#111111", "#ff3b30"]) {
    is(`store's name in ${accent}`, contrast(readableInk(accent), PAPER) >= TEXT_CONTRAST, true);
  }
  is("the ink itself", contrast(INK, PAPER) >= TEXT_CONTRAST, true);

  part("The store's initial in the seal");
  is("white on a dark color, ink on a light one", [monogramInk("#5a36ee"), monogramInk("#ffd400"), monogramInk("#111111")], ["#ffffff", INK, "#ffffff"]);

  part("The file");
  const plain = await certificatePdf(sheet);
  const sizes: number[] = [];
  for (const { id: backdrop } of BACKDROPS) {
    for (const { id: font } of FONTS) {
      const bytes = await certificatePdf({ ...sheet, look: { font, backdrop }, monogram: "H" });
      sizes.push((await PDFDocument.load(bytes)).getPageCount() === 1 ? bytes.length : -1);
    }
  }
  is("every look makes a one-page file under 250 KB", sizes.every((n) => n > 0 && n < 250_000), true);
  const looked = await certificatePdf({ ...sheet, look: { font: "modern", backdrop: "dots" }, monogram: "H" });
  const doc = await PDFDocument.load(looked);
  const plainDoc = await PDFDocument.load(plain);
  is("still tagged: a structure tree, marked, with its language", Boolean(doc.catalog.lookup(PDFName.of("StructTreeRoot"), PDFDict)) && Boolean(doc.catalog.lookup(PDFName.of("MarkInfo"), PDFDict)) && doc.catalog.get(PDFName.of("Lang")) !== undefined, true);
  const artifacts = (d: PDFDocument) => (content(d).match(/\/Artifact BMC/g) ?? []).length;
  is("the backdrop is one more piece of decoration a reader skips", [artifacts(plainDoc), artifacts(doc)], [3, 4]);
  is("a look changes the file; without one it is the sheet as it was", [looked.length !== plain.length, (await certificatePdf(sheet)).length === plain.length], [true, true]);
  const noInitial = await certificatePdf({ ...sheet, look: { font: "modern", backdrop: "plain" }, monogram: "" });
  const withInitial = await certificatePdf({ ...sheet, look: { font: "modern", backdrop: "plain" }, monogram: "H" });
  is("an initial in the seal, or the check mark without one", withInitial.length !== noInitial.length, true);
  is("an initial the letters cannot draw falls back to the check mark", (await certificatePdf({ ...sheet, look: { font: "modern", backdrop: "plain" }, monogram: "中" })).length, noInitial.length);

  done();
}

void main();
