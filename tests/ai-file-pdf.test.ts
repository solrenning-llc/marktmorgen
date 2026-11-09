/**
 * The file written with AI as a tagged PDF (758 [STN5], unit 3;
 * lib/ai-file-pdf.ts, lib/tagged-pdf.ts; PDF/UA, AX274). A file of ten parts,
 * each as long as a part is asked to be, is drawn and read back. What is
 * checked:
 *   - a structure tree in reading order: the title, the store, then each
 *     part's heading and its paragraphs, every page tied to it;
 *   - the language, the title shown, MarkInfo and the PDF/UA identification;
 *   - one bookmark for each part, opening its own page, shown when the file
 *     opens;
 *   - page numbers drawn as artifacts, outside the tree;
 *   - lines of at most 80 characters, each part from a new page;
 *   - the biggest file is far under the most a file may be;
 *   - letters the PDF cannot draw make no file.
 * What a checker such as veraPDF or a real screen reader would find is not
 * checked here.
 */
import { PDFArray, PDFDict, PDFDocument, PDFHexString, PDFName, PDFNumber, PDFRef, PDFStream, decodePDFRawStream, type PDFRawStream } from "pdf-lib";
import { FILE_SECTION_WORDS, MAX_AI_FILE_BYTES, MAX_FILE_SECTIONS, filePages } from "@/lib/ai-file-rules";
import { MAX_LINE_CHARS, fileDrawable, filePdf, wrapLines } from "@/lib/ai-file-pdf";
import { done, is, part } from "./check";

const WORDS = ["rice", "beans", "greens", "onion", "garlic", "simmer", "season", "serve", "weeknight", "dinner", "family", "kitchen"];
const paragraph = (seed: number, words: number) => Array.from({ length: words }, (_, i) => WORDS[(seed + i * 7) % WORDS.length]).join(" ");
const body = (seed: number) => Array.from({ length: 10 }, (_, p) => paragraph(seed + p, FILE_SECTION_WORDS / 10)).join("\n\n");

async function main(): Promise<void> {
  part("Lines");
  const font = { widthOfTextAtSize: (text: string, size: number) => Array.from(text).length * size * 0.3 };
  const lines = wrapLines(font, paragraph(1, 200), 12);
  is("never longer than 80 characters, even where the width would allow more", [lines.every((l) => l.length <= MAX_LINE_CHARS), lines.some((l) => l.length > 70)], [true, true]);
  is("a word longer than a line is cut where it must be", wrapLines(font, "x".repeat(170), 12).map((l) => l.length), [80, 80, 10]);

  part("A file of ten full parts");
  const draft = { title: "Weeknight Dinners for Busy Parents", sections: Array.from({ length: MAX_FILE_SECTIONS }, (_, i) => ({ title: `Part ${i + 1}: Week ${i + 1}`, body: body(i) })) };
  const made = await filePdf({ draft, storeName: "Harbor Kitchen", lang: "en", at: new Date("2026-11-09T12:00:00Z") });
  const doc = await PDFDocument.load(made.bytes);
  const pages = doc.getPages();
  const pageRefs = pages.map((p) => p.ref.toString());
  is("as many pages as it says", [made.pages, pages.length], [pages.length, made.pages]);
  is("about as many pages as the studio says, and a first page", Math.abs(pages.length - 1 - filePages(MAX_FILE_SECTIONS)) <= MAX_FILE_SECTIONS, true);
  is("far under the most a file may be", [made.bytes.byteLength < 1024 * 1024, made.bytes.byteLength <= MAX_AI_FILE_BYTES], [true, true]);

  const root = doc.catalog.lookupMaybe(PDFName.of("StructTreeRoot"), PDFDict);
  const document = root?.lookupMaybe(PDFName.of("K"), PDFDict);
  const kids = (document?.lookupMaybe(PDFName.of("K"), PDFArray)?.asArray() ?? []).map((ref) => doc.context.lookup(ref as PDFRef, PDFDict));
  const roles = kids.map((k) => k.get(PDFName.of("S"))!.toString());
  const onPage = kids.map((k) => pageRefs.indexOf((k.get(PDFName.of("Pg")) as PDFRef).toString()));
  is("the title, then the store", roles.slice(0, 2), ["/H1", "/P"]);
  is("one heading for each part", roles.filter((r) => r === "/H2").length, MAX_FILE_SECTIONS);
  is("nothing but headings and paragraphs", roles.length > 0 && roles.every((r) => ["/H1", "/H2", "/P"].includes(r)), true);
  is("in reading order: never back to an earlier page", onPage.length > 0 && onPage.every((p, i) => p >= 0 && (i === 0 || p >= onPage[i - 1])), true);
  const headings = kids.map((k, i) => ({ role: roles[i], page: onPage[i] })).filter((k) => k.role === "/H2");
  is("each part from a new page, at its top", headings.length > 0 && headings.every((h, i) => h.page > (i === 0 ? 0 : headings[i - 1].page) && roles[kids.findIndex((_, k) => onPage[k] === h.page)] === "/H2"), true);
  is("every page is tied to the tree and read in structure order", pages.map((p) => [(p.node.get(PDFName.of("StructParents")) as PDFNumber | undefined)?.asNumber(), p.node.get(PDFName.of("Tabs"))?.toString()]), pages.map((_, i) => [i, "/S"]));
  is("its language and its title, shown instead of a file name", [document?.get(PDFName.of("Lang"))?.toString(), doc.getTitle(), doc.catalog.lookupMaybe(PDFName.of("ViewerPreferences"), PDFDict)?.get(PDFName.of("DisplayDocTitle"))?.toString()], ["(en)", draft.title, "true"]);
  is("marked as tagged", doc.catalog.lookupMaybe(PDFName.of("MarkInfo"), PDFDict)?.get(PDFName.of("Marked"))?.toString(), "true");
  const meta = doc.catalog.lookupMaybe(PDFName.of("Metadata"), PDFStream) as PDFRawStream | undefined;
  const xmp = meta ? new TextDecoder().decode(meta.getContents()) : "";
  is("the PDF/UA identification in its metadata", xmp.includes("<pdfuaid:part>1</pdfuaid:part>"), true);

  part("Bookmarks");
  const outlines = doc.catalog.lookupMaybe(PDFName.of("Outlines"), PDFDict);
  const marks: { title: string; page: number }[] = [];
  let at = outlines?.get(PDFName.of("First")) as PDFRef | undefined;
  while (at) {
    const item = doc.context.lookup(at, PDFDict);
    const dest = item.lookup(PDFName.of("Dest"), PDFArray);
    marks.push({ title: (item.lookup(PDFName.of("Title")) as PDFHexString).decodeText(), page: pageRefs.indexOf((dest.get(0) as PDFRef).toString()) });
    at = item.get(PDFName.of("Next")) as PDFRef | undefined;
  }
  is("one for each part, by its title, in order", marks.map((m) => m.title), draft.sections.map((s) => s.title));
  is("each opens its part's own page", marks.map((m) => m.page), headings.map((h) => h.page));
  is("counted, and shown when the file opens", [(outlines?.get(PDFName.of("Count")) as PDFNumber | undefined)?.asNumber(), doc.catalog.get(PDFName.of("PageMode"))?.toString()], [MAX_FILE_SECTIONS, "/UseOutlines"]);

  part("Page numbers are artifacts");
  const content = (i: number) => {
    const contents = pages[i].node.Contents();
    const streams = contents instanceof PDFArray ? contents.asArray().map((r) => doc.context.lookup(r as PDFRef)) : contents ? [contents] : [];
    return streams.map((s) => new TextDecoder("latin1").decode(decodePDFRawStream(s as PDFRawStream).decode())).join("\n");
  };
  const last = content(pages.length - 1);
  is("drawn inside an artifact on every page", pages.length > 0 && pages.every((_, i) => /\/Artifact BMC[\s\S]*Tj[\s\S]*EMC\s*$/.test(content(i).trim())), true);
  is("and the text a reader reads is marked with its element", /\/P <<\s*\/MCID \d+\s*>> BDC/.test(last), true);

  part("Letters it cannot draw");
  is("a file with them is not made", [await fileDrawable(draft, "Harbor Kitchen"), await fileDrawable({ ...draft, title: "東京の料理" }, "Harbor Kitchen")], [true, false]);

  done();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
