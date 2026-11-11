/**
 * AX274 Part A, item 5 (PDF/UA, ISO 14289-1 7.5 and 7.6; WCAG 1.3.1): a table
 * in a generated PDF is read as a table, with its header cells tied to their
 * column, and a list as a list. lib/tagged-pdf.ts nests Table > TR > TH/TD
 * and L > LI > LBody under the document, and each piece of drawn text stays
 * tied to its own cell through the parent tree. Synthetic file only.
 */
import { PDFArray, PDFDict, PDFDocument, PDFName, PDFNumber, PDFRef, StandardFonts } from "pdf-lib";
import { PageTagger } from "@/lib/tagged-pdf";
import { done, is } from "./check";

function role(dict: PDFDict): string {
  return dict.lookup(PDFName.of("S"), PDFName).asString().slice(1);
}
function kids(doc: PDFDocument, dict: PDFDict): PDFDict[] {
  const k = dict.lookup(PDFName.of("K"));
  return k instanceof PDFArray ? k.asArray().map((ref) => doc.context.lookup(ref, PDFDict)) : [];
}
function mcidOf(dict: PDFDict): number | null {
  const k = dict.get(PDFName.of("K"));
  return k instanceof PDFNumber ? k.asNumber() : null;
}

async function main(): Promise<void> {
  const pdf = await PDFDocument.create();
  const font = await pdf.embedFont(StandardFonts.Helvetica);
  const page = pdf.addPage([400, 400]);
  const tag = new PageTagger(pdf, page);
  const draw = (text: string, y: number) => () => page.drawText(text, { x: 20, y, size: 10, font });
  tag.text("H1", draw("Weekly plan", 370));
  tag.group("Table", () => {
    tag.group("TR", () => {
      tag.text("TH", draw("Day", 340), undefined, { scope: "Column" });
      tag.text("TH", draw("Dinner", 340), undefined, { scope: "Column" });
    });
    tag.group("TR", () => {
      tag.text("TH", draw("Monday", 320), undefined, { scope: "Row" });
      tag.text("TD", draw("Salmon", 320));
    });
  });
  tag.group("L", () => {
    tag.group("LI", () => tag.text("LBody", draw("Oats", 300)));
    tag.group("LI", () => tag.text("LBody", draw("Berries", 290)));
  });
  tag.finish({ title: "Weekly plan", author: "A store", producer: "test", lang: "en-US", at: new Date(Date.UTC(2026, 10, 11)) });
  const doc = await PDFDocument.load(await pdf.save());

  const root = doc.catalog.lookup(PDFName.of("StructTreeRoot"), PDFDict);
  const document = root.lookup(PDFName.of("K"), PDFDict);
  const top = kids(doc, document);
  is("the document holds a heading, a table and a list, in reading order", top.map(role), ["H1", "Table", "L"]);
  const rows = kids(doc, top[1]);
  is("the table holds its rows", rows.map(role), ["TR", "TR"]);
  is("each row holds its cells", rows.map((r) => kids(doc, r).map(role)), [["TH", "TH"], ["TH", "TD"]]);
  const scope = (cell: PDFDict) => {
    const a = cell.lookup(PDFName.of("A"));
    return a instanceof PDFDict ? [a.get(PDFName.of("O"))?.toString(), a.get(PDFName.of("Scope"))?.toString()] : null;
  };
  is("header cells say which way they head (Table attribute Scope)", rows.map((r) => kids(doc, r).map(scope)), [
    [["/Table", "/Column"], ["/Table", "/Column"]],
    [["/Table", "/Row"], null],
  ]);
  const items = kids(doc, top[2]);
  is("the list holds its items, each with its body", items.map((i) => [role(i), kids(doc, i).map(role)]), [["LI", ["LBody"]], ["LI", ["LBody"]]]);

  const parentOf = (d: PDFDict) => doc.context.lookup(d.get(PDFName.of("P")) as PDFRef, PDFDict);
  is("every element points back to the one that holds it", [
    parentOf(top[1]) === document,
    parentOf(rows[0]) === top[1],
    parentOf(kids(doc, rows[0])[0]) === rows[0],
    parentOf(kids(doc, items[1])[0]) === items[1],
  ], [true, true, true, true]);

  const leaves = [top[0], ...rows.flatMap((r) => kids(doc, r)), ...items.flatMap((i) => kids(doc, i))];
  is("each drawn piece of text is its own marked content, in order", leaves.map(mcidOf), [0, 1, 2, 3, 4, 5, 6]);
  const tree = root.lookup(PDFName.of("ParentTree"), PDFDict).lookup(PDFName.of("Nums"), PDFArray);
  const onPage = doc.context.lookup(tree.get(1), PDFArray).asArray().map((ref) => doc.context.lookup(ref, PDFDict));
  is("the parent tree ties each marked content to its own cell or item", onPage.map(role), ["H1", "TH", "TH", "TH", "TD", "LBody", "LBody"]);
  is("the parent tree's entries are those very elements", onPage.every((d, i) => d === leaves[i]), true);
  done();
}

void main();
