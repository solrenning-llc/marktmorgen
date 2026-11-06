/**
 * The buyer's line on a stamped PDF is decoration to a screen reader (AX274
 * asks the PDFs the site hands over to follow PDF/UA; ISO 14289-1, 7.1: all
 * content is either tagged or marked as an artifact). A creator's tagged PDF
 * keeps its structure tree exactly as it was, and the line drawn on each page
 * sits inside an `/Artifact` marked-content sequence of the pagination kind
 * (a footer), so a reader skips it instead of finding loose text with no
 * element. An untagged PDF opens as before, with the line on every page.
 * Read back from the saved bytes. Not proven here: a veraPDF run and a real
 * screen reader (gaps), and the standard font, which is not embedded.
 */
import { PDFArray, PDFDict, PDFDocument, PDFName, PDFNumber, PDFRawStream, PDFRef, StandardFonts, decodePDFRawStream, degrees } from "pdf-lib";
import { certificatePdf } from "@/lib/certificate-pdf";
import { stampLine } from "@/lib/pdf-stamp-line";
import { stampPdf } from "@/lib/pdf-stamp";
import { done, is, part } from "./check";

const sheet = {
  name: "Ana Souza",
  title: "Knife Skills",
  storeName: "Harbor Kitchen",
  kicker: "Certificate of completion",
  certifies: "This certifies that",
  hasCompleted: "has completed",
  taughtBy: "taught by Harbor Kitchen, on October 11, 2026",
  idLine: "Certificate ID abcdefgh12345678",
  checkLine: "Check it at marktmorgen.com/@harbor/certificate/abcdefgh12345678",
  stamp: "",
  accent: "#5a36ee",
  lang: "en",
};
const line = stampLine("maya@example.com", "cs_test_a1B2c3D4e5F6", new Date("2026-09-26T12:00:00Z"));

function content(doc: PDFDocument, index: number): string {
  const raw = doc.getPages()[index].node.Contents();
  const refs = raw instanceof PDFArray ? raw.asArray() : raw ? [raw] : [];
  return refs
    .map((ref) => {
      const stream = doc.context.lookup(ref as PDFRef);
      return stream instanceof PDFRawStream ? new TextDecoder("latin1").decode(decodePDFRawStream(stream).decode()) : "";
    })
    .join("\n");
}

/** WinAnsi bytes of a hex string, read back as text (… is 0x85 there). */
function winAnsi(hex: string): string {
  const bytes = hex.match(/../g) ?? [];
  return bytes.map((b) => (b.toUpperCase() === "85" ? "…" : String.fromCharCode(parseInt(b, 16)))).join("");
}

type Shown = { text: string; inside: "tag" | "artifact" | "loose"; artifactProps: string };

/**
 * Walks a content stream written by pdf-lib (one operator per line; an inline
 * dictionary operand may span lines) and says, for every text-showing
 * operator, whether it sits in a tagged element, an artifact or nowhere.
 */
function shown(stream: string): Shown[] {
  const out: Shown[] = [];
  const open: { kind: "tag" | "artifact"; props: string }[] = [];
  let operands = "";
  for (const row of stream.split("\n")) {
    operands = operands ? `${operands}\n${row}` : row;
    const depth = (operands.match(/<</g) ?? []).length - (operands.match(/>>/g) ?? []).length;
    if (depth > 0) continue;
    const op = /(?:^|\s)(BDC|BMC|EMC|Tj|TJ)\s*$/.exec(operands)?.[1];
    if (op === "BDC" || op === "BMC") {
      const artifact = /^\s*\/Artifact\b/.test(operands);
      open.push({ kind: artifact ? "artifact" : "tag", props: artifact ? operands.replace(/\s+/g, " ").trim() : "" });
    } else if (op === "EMC") open.pop();
    else if (op === "Tj" || op === "TJ") {
      const where = open.find((o) => o.kind === "artifact") ?? open[open.length - 1];
      const hex = /<([0-9A-Fa-f]*)>\s*Tj\s*$/.exec(operands)?.[1];
      out.push({ text: hex === undefined ? "" : winAnsi(hex), inside: where ? where.kind : "loose", artifactProps: where?.kind === "artifact" ? where.props : "" });
    }
    operands = "";
  }
  return out;
}

/** The structure tree, as plain data: each element's role, page and marked-content id, and the parent tree. */
function tree(doc: PDFDocument): unknown {
  const root = doc.catalog.lookup(PDFName.of("StructTreeRoot"), PDFDict);
  const document = root.lookup(PDFName.of("K"), PDFDict);
  const kids = document.lookup(PDFName.of("K"), PDFArray).asArray().map((ref) => doc.context.lookup(ref, PDFDict));
  const pages = doc.getPages().map((p) => p.ref.toString());
  const parentTree = root.lookup(PDFName.of("ParentTree"), PDFDict).lookup(PDFName.of("Nums"), PDFArray).asArray().map((v) => v.toString());
  return {
    document: document.get(PDFName.of("S"))?.toString(),
    lang: document.get(PDFName.of("Lang"))?.toString(),
    elements: kids.map((e) => [e.get(PDFName.of("S"))?.toString(), pages.indexOf((e.get(PDFName.of("Pg")) as PDFRef).toString()), (e.get(PDFName.of("K")) as PDFNumber).asNumber()]),
    parentTree,
    nextKey: (root.get(PDFName.of("ParentTreeNextKey")) as PDFNumber).asNumber(),
    marked: doc.catalog.lookup(PDFName.of("MarkInfo"), PDFDict).get(PDFName.of("Marked"))?.toString(),
    structParents: doc.getPages().map((p) => (p.node.get(PDFName.of("StructParents")) as PDFNumber | undefined)?.asNumber()),
    mcids: doc.getPages().map((_, i) => (content(doc, i).match(/\/MCID \d+/g) ?? []).join(",")),
  };
}

async function main(): Promise<void> {
  part("A creator's tagged PDF");
  const tagged = await certificatePdf(sheet);
  const before = await PDFDocument.load(tagged);
  const after = await PDFDocument.load(await stampPdf(tagged, line));
  const was = shown(content(before, 0));
  const now = shown(content(after, 0));
  const stamp = now.filter((s) => !was.some((w) => w.text === s.text && w.inside === s.inside));
  is("the page shows one more piece of text: the buyer's line", [now.length - was.length, stamp.map((s) => s.text)], [1, [line]]);
  is("the line is marked as an artifact, not loose text with no element", stamp.map((s) => s.inside), ["artifact"]);
  is("…of the pagination kind, a footer", stamp.map((s) => s.artifactProps), ["/Artifact << /Type /Pagination /Subtype /Footer >> BDC"]);
  is("every other piece of text is where it was: tagged, none loose", [now.filter((s) => s.inside === "tag").length, now.filter((s) => s.inside === "loose").length], [was.filter((s) => s.inside === "tag").length, 0]);
  is("the structure tree, parent tree, page keys and marked-content ids are untouched", tree(after), tree(before));
  is("the line carries no marked-content id of its own", (content(after, 0).match(/\/MCID/g) ?? []).length, (content(before, 0).match(/\/MCID/g) ?? []).length);
  is("the language and title the file had are kept", [after.catalog.get(PDFName.of("Lang"))?.toString(), after.getTitle()], [before.catalog.get(PDFName.of("Lang"))?.toString(), before.getTitle()]);
  is("marked sequences stay balanced on the page", (() => {
    let depth = 0;
    for (const row of content(after, 0).split("\n")) {
      if (/(BDC|BMC)\s*$/.test(row)) depth += 1;
      else if (/^\s*EMC\s*$/.test(row)) depth -= 1;
      if (depth < 0) return false;
    }
    return depth === 0;
  })(), true);

  part("An untagged PDF, two pages, one stored sideways");
  const plain = await PDFDocument.create();
  const font = await plain.embedFont(StandardFonts.Helvetica);
  const first = plain.addPage([612, 792]);
  first.drawText("Chapter one", { x: 72, y: 700, size: 18, font });
  const second = plain.addPage([792, 612]);
  second.setRotation(degrees(90));
  second.drawText("Chapter two", { x: 72, y: 500, size: 18, font });
  const out = await PDFDocument.load(await stampPdf(await plain.save(), line));
  is("it opens, with both pages", out.getPageCount(), 2);
  is("no structure is invented for it", [out.catalog.get(PDFName.of("StructTreeRoot")), out.catalog.get(PDFName.of("MarkInfo"))], [undefined, undefined]);
  for (const i of [0, 1]) {
    const texts = shown(content(out, i));
    is(`page ${i + 1}: the creator's text is shown as before and the buyer's line is shown too`, texts.map((s) => [s.text, s.inside]), [[i === 0 ? "Chapter one" : "Chapter two", "loose"], [line, "artifact"]]);
  }

  done();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
