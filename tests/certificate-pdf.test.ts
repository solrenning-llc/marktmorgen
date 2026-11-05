/**
 * A certificate of completion as a PDF file (lib/certificate-pdf.ts, added
 * 11 October 2026). What is checked:
 *
 *   - one landscape US Letter page, with the store as its author;
 *   - the letters cover the names a store in Europe or the Americas meets,
 *     Polish, Czech, Turkish, Greek and Russian included, and say no to a
 *     script they do not cover rather than drawing empty boxes;
 *   - a very long name or title still fits the sheet.
 */
import { PDFDocument } from "pdf-lib";
import { canDraw, certificatePdf } from "@/lib/certificate-pdf";
import { done, is, part } from "./check";

const sheet = {
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

async function main(): Promise<void> {
  part("The file");
  const bytes = await certificatePdf(sheet);
  const read = await PDFDocument.load(bytes);
  const [page] = read.getPages();
  is("one landscape US Letter page, made by the store", [read.getPageCount(), Math.round(page.getWidth()), Math.round(page.getHeight()), read.getAuthor(), read.getTitle()], [1, 792, 612, "Harbor Kitchen", "Certificate of completion — Łukasz Żółć"]);
  is("only the letters it uses are embedded, so it stays light", bytes.length < 120_000, true);
  const long = await certificatePdf({ ...sheet, name: "Maria Fernanda de los Ángeles Rodríguez-Villanueva y Castellanos", title: "The complete guide to weeknight dinners for families who are always short of time".repeat(2) });
  is("a very long name and title still make a file", (await PDFDocument.load(long)).getPageCount(), 1);
  const sample = await certificatePdf({ ...sheet, stamp: "Sample" });
  is("a sample carries its stamp", sample.length > bytes.length, true);

  part("The letters");
  is("names from Europe and the Americas, in every alphabet the file carries", await canDraw("Łukasz Żółć", "Jiří Řezníček", "Ayşe Gökçe", "Ελένη Παπαδοπούλου", "Анна Иванова", "François Lefèvre", "Nguyễn Văn An"), true);
  is("and no to one it does not, so nothing is drawn as empty boxes", [await canDraw("王小明"), await canDraw("محمد"), await canDraw("Ana 😀")], [false, false, false]);
  done();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
