/**
 * 630 [HN6](8), unit 1: the certificate's PDF tagged for screen readers
 * (lib/tagged-pdf.ts, lib/certificate-pdf.ts). Read back from the saved file:
 * the structure tree in reading order (one heading, then paragraphs), every
 * piece of text inside a tagged element and everything else marked as
 * decoration, a cut line read in full, the language, the title shown, the
 * PDF/UA part in the XMP metadata, and every line of text at 7:1 on the paper.
 * Not proven here: a veraPDF run and a real screen reader (gaps).
 */
import { PDFArray, PDFDict, PDFDocument, PDFHexString, PDFName, PDFNumber, PDFRawStream, PDFRef, PDFString, decodePDFRawStream } from "pdf-lib";
import { INK, PAPER, TEXT_CONTRAST, certificatePdf, readableInk } from "@/lib/certificate-pdf";
import { xmpPacket } from "@/lib/tagged-pdf";
import { contrast } from "@/lib/store-look";
import { done, is, part } from "./check";

const sheet = {
  name: "Ana Souza",
  title: "Knife Skills",
  storeName: "Harbor & Sons <Kitchen>",
  kicker: "Certificate of completion",
  certifies: "This certifies that",
  hasCompleted: "has completed",
  taughtBy: "taught by Harbor Kitchen, on October 11, 2026",
  idLine: "Certificate ID abcdefgh12345678",
  checkLine: "Check it at marktmorgen.com/@harbor/certificate/abcdefgh12345678",
  stamp: "",
  accent: "#ffd400",
  lang: "pt",
};

function content(doc: PDFDocument): string {
  const page = doc.getPages()[0];
  const raw = page.node.Contents();
  const refs = raw instanceof PDFArray ? raw.asArray() : [raw];
  return refs
    .map((ref) => {
      const stream = doc.context.lookup(ref as PDFRef);
      return stream instanceof PDFRawStream ? new TextDecoder("latin1").decode(decodePDFRawStream(stream).decode()) : "";
    })
    .join("\n");
}

/** Every text-showing operator, with whether it sits in a tagged element or an artifact. */
function textPlaces(stream: string): { tagged: number; artifact: number; loose: number } {
  const counts = { tagged: 0, artifact: 0, loose: 0 };
  const open: string[] = [];
  for (const line of stream.split("\n")) {
    if (/BDC\s*$/.test(line) || /\/MCID/.test(line)) {
      if (/BDC\s*$/.test(line)) open.push("tag");
    } else if (/^\/Artifact BMC/.test(line.trim())) open.push("artifact");
    else if (/^EMC/.test(line.trim())) open.pop();
    if (/(Tj|TJ)\s*$/.test(line)) {
      const where = open[open.length - 1];
      if (where === "tag") counts.tagged += 1;
      else if (where === "artifact") counts.artifact += 1;
      else counts.loose += 1;
    }
  }
  return counts;
}

function elements(doc: PDFDocument): PDFDict[] {
  const root = doc.catalog.lookup(PDFName.of("StructTreeRoot"), PDFDict);
  const document = root.lookup(PDFName.of("K"), PDFDict);
  return document.lookup(PDFName.of("K"), PDFArray).asArray().map((ref) => doc.context.lookup(ref, PDFDict));
}

async function main(): Promise<void> {
  part("The structure a screen reader follows");
  const doc = await PDFDocument.load(await certificatePdf(sheet));
  const read = elements(doc);
  is("one heading, then paragraphs, in reading order", read.map((e) => e.get(PDFName.of("S"))?.toString()), ["/P", "/H1", "/P", "/P", "/P", "/P", "/P", "/P", "/P"]);
  is("each element points at its own marked content, 0 to 8", read.map((e) => (e.get(PDFName.of("K")) as PDFNumber).asNumber()), [0, 1, 2, 3, 4, 5, 6, 7, 8]);
  const stream = content(doc);
  is("every marked content id appears once in the page", [0, 1, 2, 3, 4, 5, 6, 7, 8].every((n) => stream.split(`/MCID ${n}`).length === 2), true);
  is("every line of text is tagged; none is loose", textPlaces(stream), { tagged: 9, artifact: 0, loose: 0 });
  is("the frame, rule and seal are marked as decoration", (stream.match(/\/Artifact BMC/g) ?? []).length, 3);
  is("the page knows where its elements are", (doc.getPages()[0].node.get(PDFName.of("StructParents")) as PDFNumber).asNumber(), 0);

  part("The sample stamp");
  const sample = await PDFDocument.load(await certificatePdf({ ...sheet, stamp: "Sample" }));
  is("the faint stamp is decoration; the elements are the same", [elements(sample).length, textPlaces(content(sample))], [9, { tagged: 9, artifact: 1, loose: 0 }]);

  part("A line cut to fit is read in full");
  const long = "The complete guide to weeknight dinners for families who are always short of time ".repeat(3).trim();
  const cut = await PDFDocument.load(await certificatePdf({ ...sheet, title: long }));
  const title = elements(cut)[5].get(PDFName.of("ActualText"));
  is("the course title's element carries the whole title", title instanceof PDFHexString ? title.decodeText() : null, long);
  is("a line that fits has no replacement text", elements(doc)[5].get(PDFName.of("ActualText")), undefined);

  part("Language, title and metadata");
  is("the file's language is the store's", (doc.catalog.get(PDFName.of("Lang")) as PDFString | PDFHexString).decodeText(), "pt");
  is("marked as tagged", (doc.catalog.lookup(PDFName.of("MarkInfo"), PDFDict).get(PDFName.of("Marked")) ?? "").toString(), "true");
  is("the viewer shows the title, not the file name", (doc.catalog.lookup(PDFName.of("ViewerPreferences"), PDFDict).get(PDFName.of("DisplayDocTitle")) ?? "").toString(), "true");
  is("title and author as before", [doc.getTitle(), doc.getAuthor()], ["Certificate of completion — Ana Souza", "Harbor & Sons <Kitchen>"]);
  const xmp = doc.catalog.lookup(PDFName.of("Metadata")) as PDFRawStream;
  const packet = new TextDecoder().decode(xmp.getContents());
  is("the metadata names PDF/UA part 1", packet.includes("<pdfuaid:part>1</pdfuaid:part>"), true);
  is("…with the title, escaped", packet.includes("Certificate of completion — Ana Souza</rdf:li>"), true);
  is("…and the author, escaped", packet.includes("Harbor &amp; Sons &lt;Kitchen&gt;"), true);
  is("the packet is plain XML (not compressed)", xmp.dict.get(PDFName.of("Filter")), undefined);
  is("dates without fractions of a second", /<xmp:CreateDate>2026-01-02T03:04:05Z</.test(xmpPacket({ title: "t", author: "a", producer: "p", lang: "en", at: new Date("2026-01-02T03:04:05.678Z") })), true);

  part("Text at 7:1 on the paper");
  for (const accent of ["#ffd400", "#5a36ee", "#00c2a8", "#ff4f5e", "#ffffff", "#000000", "not a color"]) {
    is(`the store's name in ${accent} reads at 7:1`, contrast(readableInk(accent), PAPER) >= TEXT_CONTRAST, true);
  }
  is("a dark color already at 7:1 is kept as it is", readableInk("#1d1b4f"), "#1d1b4f");
  is("the ink is far above it", contrast(INK, PAPER) >= TEXT_CONTRAST, true);
  is("the softer ink too", contrast(readableInk("#5c5a6b"), PAPER) >= TEXT_CONTRAST, true);
  done();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
