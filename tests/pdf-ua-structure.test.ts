/**
 * AX274 Part A, item 5: the PDFs Marktmorgen generates (a course certificate
 * and a form answer) are tagged for PDF/UA. This reads each generated file
 * with pdf-lib's parser, offline, and checks the PDF/UA-1 (ISO 14289-1)
 * requirements a file's structure can show: marked as tagged with no suspects
 * (7.1), a structure tree with the Document element and its language, the
 * catalog language (7.2), the title shown in the window (7.1, 10), the PDF/UA
 * identification in XMP (5), every font embedded (7.21.4.1) with a ToUnicode
 * map so text can be read aloud (7.21.7), each page's structural tab order
 * (7.18.3), and headings that start at H1 and never skip a level (7.4.2).
 *
 * This is not a conformance claim: veraPDF and a reading with a real screen
 * reader stay to be done.
 */
import { PDFArray, PDFBool, PDFDict, PDFDocument, PDFName, PDFNumber, PDFRawStream, PDFRef, PDFString, PDFHexString } from "pdf-lib";
import { certificatePdf } from "@/lib/certificate-pdf";
import { responsePdf } from "@/lib/form-response-pdf";
import { parseForm, type FormDef, type FormResponse } from "@/lib/forms";
import { done, is, part } from "./check";

const text = (value: unknown): string => (value instanceof PDFString || value instanceof PDFHexString ? value.decodeText() : "");

function fontsOf(doc: PDFDocument): PDFDict[] {
  const seen = new Map<string, PDFDict>();
  for (const page of doc.getPages()) {
    const fonts = page.node.Resources()?.lookupMaybe(PDFName.of("Font"), PDFDict);
    for (const [, ref] of fonts?.entries() ?? []) {
      const font = doc.context.lookup(ref, PDFDict);
      seen.set(String(ref), font);
    }
  }
  return [...seen.values()];
}

/** The descriptor that holds the font program: a Type0 font's is on its descendant. */
function descriptorOf(doc: PDFDocument, font: PDFDict): PDFDict | undefined {
  const descendants = font.lookupMaybe(PDFName.of("DescendantFonts"), PDFArray);
  const holder = descendants ? doc.context.lookup(descendants.get(0), PDFDict) : font;
  return holder.lookupMaybe(PDFName.of("FontDescriptor"), PDFDict);
}

function roles(doc: PDFDocument, root: PDFDict): string[] {
  const document = root.lookup(PDFName.of("K"), PDFDict);
  return document
    .lookup(PDFName.of("K"), PDFArray)
    .asArray()
    .map((ref) => doc.context.lookup(ref as PDFRef, PDFDict).lookup(PDFName.of("S"), PDFName).decodeText());
}

async function pdfUa(name: string, bytes: Uint8Array, lang: string, title: string): Promise<void> {
  const doc = await PDFDocument.load(bytes, { updateMetadata: false });
  const catalog = doc.catalog;
  const mark = catalog.lookupMaybe(PDFName.of("MarkInfo"), PDFDict);
  is(`${name}: marked as tagged, no suspects (7.1)`, [mark?.lookupMaybe(PDFName.of("Marked"), PDFBool)?.asBoolean(), mark?.lookupMaybe(PDFName.of("Suspects"), PDFBool)?.asBoolean()], [true, false]);
  is(`${name}: the catalog says the language (7.2)`, text(catalog.lookupMaybe(PDFName.of("Lang"), PDFString, PDFHexString)), lang);
  const root = catalog.lookup(PDFName.of("StructTreeRoot"), PDFDict);
  const document = root.lookup(PDFName.of("K"), PDFDict);
  is(`${name}: one Document element at the root of the structure tree`, document.lookup(PDFName.of("S"), PDFName).decodeText(), "Document");
  is(`${name}: the Document element says the language`, text(document.lookupMaybe(PDFName.of("Lang"), PDFString, PDFHexString)), lang);
  is(`${name}: the window shows the title, not the file name`, catalog.lookupMaybe(PDFName.of("ViewerPreferences"), PDFDict)?.lookupMaybe(PDFName.of("DisplayDocTitle"), PDFBool)?.asBoolean(), true);
  is(`${name}: the title is set`, doc.getTitle(), title);
  const metadata = catalog.get(PDFName.of("Metadata"));
  const xmp = metadata instanceof PDFRef ? doc.context.lookup(metadata) : undefined;
  is(`${name}: XMP carries the PDF/UA identification (5)`, Boolean(xmp instanceof PDFRawStream && new TextDecoder().decode(xmp.contents).includes("<pdfuaid:part>1</pdfuaid:part>")), true);
  const fonts = fontsOf(doc);
  is(`${name}: draws with at least one font`, fonts.length > 0, true);
  is(
    `${name}: every font is embedded (7.21.4.1)`,
    fonts.every((font) => {
      const descriptor = descriptorOf(doc, font);
      return Boolean(descriptor && ["FontFile", "FontFile2", "FontFile3"].some((key) => descriptor.has(PDFName.of(key))));
    }),
    true,
  );
  is(`${name}: every font maps its glyphs to Unicode (7.21.7)`, fonts.every((font) => font.has(PDFName.of("ToUnicode"))), true);
  is(
    `${name}: every page reads in structure order and points at its marked content (7.18.3)`,
    doc.getPages().every((page) => page.node.lookupMaybe(PDFName.of("Tabs"), PDFName)?.decodeText() === "S" && page.node.lookupMaybe(PDFName.of("StructParents"), PDFNumber) !== undefined),
    true,
  );
  const headings = roles(doc, root)
    .filter((role) => /^H[1-6]$/.test(role))
    .map((role) => Number(role.slice(1)));
  is(`${name}: the first heading is H1 and no level is skipped (7.4.2)`, headings[0] === 1 && headings.every((level, i) => i === 0 || level <= headings[i - 1] + 1), true);
}

const certificate = {
  name: "Łukasz Żółć",
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

const form = parseForm({
  id: "frm0000001", name: "Coaching application", button: "", doneHeading: "", doneBody: "", offerList: false, updatedAt: 1,
  outcomes: [{ id: "res001", title: "A good fit", body: "", product: "" }],
  fields: [
    { id: "aaaaaa", type: "email", label: "Your email", required: true, options: [] },
    { id: "cccccc", type: "long", label: "Tell me about your business", required: false, options: [] },
  ],
}) as FormDef;
const response: FormResponse = { id: "a".repeat(32), at: 1_790_000_000, page: "p1", answers: { aaaaaa: "dana@example.com", cccccc: "I sell recipes.\nMostly to busy parents." }, outcome: "res001", joined: false } as FormResponse;

async function main(): Promise<void> {
  part("the course certificate");
  await pdfUa("certificate", await certificatePdf(certificate), "en", "Certificate of completion — Łukasz Żółć");
  part("a form answer");
  await pdfUa("form answer", await responsePdf({ form, response, storeName: "Harbor Kitchen", sentLine: "Sent on September 21, 2026", lang: "de" }), "de", "Coaching application — Sent on September 21, 2026");
  done();
}

void main();
