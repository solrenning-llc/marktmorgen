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

  // Review of #3772 (Claude 3, nuvem L), LEVE 1 and 2: a table that runs over a page turn stays one table, each cell
  // tied to its own page; a group with nothing drawn in it (an empty list, a row with no cell) is not written, since
  // a reader would announce an empty list and PDF/UA checkers flag an empty structure element.
  const pdf2 = await PDFDocument.create();
  const font2 = await pdf2.embedFont(StandardFonts.Helvetica);
  const first = pdf2.addPage([400, 400]);
  const tag2 = new PageTagger(pdf2, first);
  let on = first;
  const draw2 = (text: string, y: number) => () => on.drawText(text, { x: 20, y, size: 10, font: font2 });
  tag2.text("H1", draw2("Orders", 370));
  tag2.group("Table", () => {
    tag2.group("TR", () => {
      tag2.text("TH", draw2("Item", 340), undefined, { scope: "Column" });
      tag2.text("TH", draw2("Price", 340), undefined, { scope: "Column" });
    });
    tag2.group("TR", () => tag2.text("TD", draw2("Bread", 320)));
    on = pdf2.addPage([400, 400]);
    tag2.nextPage(on);
    tag2.group("TR", () => tag2.text("TD", draw2("Butter", 370)));
    tag2.group("TR", () => {});
  });
  tag2.text("P", draw2("Thank you", 340));
  tag2.group("L", () => {});
  tag2.group("L", () => tag2.group("LI", () => {}));
  tag2.finish({ title: "Orders", author: "A store", producer: "test", lang: "en-US", at: new Date(Date.UTC(2026, 10, 13)) });
  const doc2 = await PDFDocument.load(await pdf2.save());
  const root2 = doc2.catalog.lookup(PDFName.of("StructTreeRoot"), PDFDict);
  const top2 = kids(doc2, root2.lookup(PDFName.of("K"), PDFDict));
  is("over a page turn: one table, then the paragraph; no empty list is written", top2.map(role), ["H1", "Table", "P"]);
  const rows2 = kids(doc2, top2[1]);
  is("the table keeps its three rows across the page turn, and no empty row", rows2.map((r) => kids(doc2, r).map(role)), [["TH", "TH"], ["TD"], ["TD"]]);
  const tree2 = root2.lookup(PDFName.of("ParentTree"), PDFDict).lookup(PDFName.of("Nums"), PDFArray);
  const page2 = (i: number) => doc2.context.lookup(tree2.get(2 * i + 1), PDFArray).asArray().map((ref) => doc2.context.lookup(ref, PDFDict));
  is("each page's marked content is tied to its own cells", [page2(0).map(role), page2(1).map(role)], [["H1", "TH", "TH", "TD"], ["TD", "P"]]);
  is("the cell on the second page is the table's own", page2(1)[0] === kids(doc2, rows2[2])[0], true);
  done();
}

void main();
