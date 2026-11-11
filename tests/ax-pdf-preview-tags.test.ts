/**
 * AX274 Part A, item 5 (PDF/UA, ISO 14289-1 7.1, 7.2): the preview of a
 * creator's PDF (lib/pdf-preview.ts, firstPages) keeps what makes a tagged
 * source readable: its language, its title shown, and the structure of the
 * pages it keeps, tied to the copied pages. And it never carries anything of
 * the pages it leaves out, not even through the structure tree: the preview is
 * what a visitor gets free. Synthetic files only.
 */
import { inflateSync, constants } from "node:zlib";
import { PDFArray, PDFDict, PDFDocument, PDFName, PDFNumber, type PDFRef, PDFString, StandardFonts } from "pdf-lib";
import { firstPages } from "@/lib/pdf-preview";
import { PageTagger } from "@/lib/tagged-pdf";
import { done, is, part } from "./check";

const SECRET = "Only buyers read page three";

async function taggedBook(): Promise<Uint8Array> {
  const pdf = await PDFDocument.create();
  const font = await pdf.embedFont(StandardFonts.Helvetica);
  const pages = [pdf.addPage([300, 300]), pdf.addPage([300, 300]), pdf.addPage([300, 300])];
  const tag = new PageTagger(pdf, pages[0]);
  tag.text("H1", () => pages[0].drawText("Chapter one", { x: 20, y: 260, size: 18, font }));
  tag.group("L", () => tag.group("LI", () => tag.text("LBody", () => pages[0].drawText("Oats", { x: 20, y: 230, size: 10, font }))));
  tag.nextPage(pages[1]);
  tag.text("P", () => pages[1].drawText("Page two words", { x: 20, y: 260, size: 10, font }));
  tag.nextPage(pages[2]);
  // A long line shortened on the page; its element carries the whole of it.
  tag.text("P", () => pages[2].drawText("Only buyers...", { x: 20, y: 260, size: 10, font }), SECRET);
  tag.finish({ title: "A synthetic book", author: "A creator", producer: "test", lang: "en-US", at: new Date(Date.UTC(2026, 10, 11)) });
  return pdf.save();
}

/** Everything in the file a reader could get at: the bytes and every stream inflated. */
function everything(bytes: Uint8Array): string {
  const raw = Buffer.from(bytes);
  const text = raw.toString("latin1");
  const out = [text];
  const pattern = /stream\r?\n/g;
  for (let m = pattern.exec(text); m; m = pattern.exec(text)) {
    const from = m.index + m[0].length;
    const to = text.indexOf("endstream", from);
    if (to < 0) break;
    try {
      out.push(inflateSync(raw.subarray(from, to), { finishFlush: constants.Z_SYNC_FLUSH }).toString("latin1"));
    } catch {
      // not compressed
    }
  }
  return out.join("\n");
}

function hexOf(text: string): string {
  return Buffer.from(text, "utf16le").swap16().toString("hex").toUpperCase();
}

async function main(): Promise<void> {
  part("A tagged source");
  const source = await taggedBook();
  const preview = await firstPages(source, 2);
  const doc = await PDFDocument.load(preview);
  is("the preview holds the first two pages", doc.getPageCount(), 2);
  const lang = doc.catalog.lookup(PDFName.of("Lang"));
  is("the preview says the source's language", lang instanceof PDFString ? lang.decodeText() : null, "en-US");
  const prefs = doc.catalog.lookup(PDFName.of("ViewerPreferences"));
  is("the preview shows its title", prefs instanceof PDFDict ? prefs.get(PDFName.of("DisplayDocTitle"))?.toString() : null, "true");
  const root = doc.catalog.lookup(PDFName.of("StructTreeRoot"));
  const mark = doc.catalog.lookup(PDFName.of("MarkInfo"));
  is("the preview is tagged", [root instanceof PDFDict, mark instanceof PDFDict ? mark.get(PDFName.of("Marked"))?.toString() : null], [true, "true"]);
  if (root instanceof PDFDict) {
    const roles: string[] = [];
    const pageRefs = doc.getPages().map((p) => p.ref);
    let pointsElsewhere = 0;
    const walk = (d: PDFDict) => {
      roles.push(d.lookup(PDFName.of("S"), PDFName).asString().slice(1));
      const pg = d.get(PDFName.of("Pg"));
      if (pg && !pageRefs.some((r) => r === pg)) pointsElsewhere += 1;
      const k = d.lookup(PDFName.of("K"));
      if (k instanceof PDFArray) for (const kid of k.asArray()) {
        const found = doc.context.lookup(kid);
        if (found instanceof PDFDict && found.has(PDFName.of("S"))) walk(found);
      }
    };
    walk(root.lookup(PDFName.of("K"), PDFDict));
    is("the kept pages' structure is there, nested as it was", roles, ["Document", "H1", "L", "LI", "LBody", "P"]);
    is("every element's page is a page of the preview", pointsElsewhere, 0);
    const nums = root.lookup(PDFName.of("ParentTree"), PDFDict).lookup(PDFName.of("Nums"), PDFArray);
    const entries: string[][] = [];
    for (let i = 0; i < nums.size(); i += 2) {
      const list = doc.context.lookup(nums.get(i + 1), PDFArray);
      entries.push(list.asArray().map((ref) => doc.context.lookup(ref as PDFRef, PDFDict).lookup(PDFName.of("S"), PDFName).asString().slice(1)));
    }
    is("the parent tree ties each page's marked content to its element", entries, [["H1", "LBody"], ["P"]]);
    is("each page says where it is in the parent tree", doc.getPages().map((p) => (p.node.get(PDFName.of("StructParents")) as PDFNumber | undefined)?.asNumber() ?? null), [0, 1]);
  }
  const all = everything(preview);
  is("nothing of the page left out is in the file, in letters or in a tag's text", [all.includes(SECRET), all.includes(hexOf(SECRET)), all.includes("Only buyers")], [false, false, false]);

  part("An untagged source");
  const plain = await PDFDocument.create();
  const font = await plain.embedFont(StandardFonts.Helvetica);
  for (let i = 0; i < 3; i += 1) plain.addPage([200, 200]).drawText(`Plain page ${i + 1}`, { x: 10, y: 100, size: 10, font });
  plain.setTitle("Plain");
  plain.setLanguage("fr-FR");
  const plainPreview = await PDFDocument.load(await firstPages(await plain.save(), 1));
  is("an untagged source gives an untagged preview, with its language", [plainPreview.catalog.has(PDFName.of("StructTreeRoot")), (plainPreview.catalog.lookup(PDFName.of("Lang")) as PDFString | undefined)?.decodeText() ?? null], [false, "fr-FR"]);

  part("A marked-content number out of range: the preview is untagged, at once (Claude 3, cloud D, and Claude 1, cloud reviewer C4, on #3785)");
  // The number comes from the creator's file and was used as an array index with no bound: 500 million of them ran
  // the server out of memory, which no try/catch holds. Above a small cap, negative or not whole, the tree is unread.
  for (const mcid of [20_000_000, -1, 1.5]) {
    const odd = await withFirstMcid(source, mcid);
    const started = Date.now();
    const oddPreview = await PDFDocument.load(await firstPages(odd, 1));
    const took = Date.now() - started;
    is(`MCID ${mcid}: no structure tree, made in well under a second (${took} ms)`, [oddPreview.catalog.has(PDFName.of("StructTreeRoot")), took < 1000], [false, true]);
  }

  part("An element partly on a page left out keeps no text of its attributes (Claude 3, cloud D, and Claude 1 on #3785)");
  const SUMMARY = "Totals that only page three holds";
  const spanning = await withSpanningTable(source, SUMMARY);
  const spanningPreview = await firstPages(spanning, 2);
  const spanAll = everything(spanningPreview);
  is("the table's summary, which may describe the page left out, is not in the preview", [spanAll.includes(SUMMARY), spanAll.includes(hexOf(SUMMARY))], [false, false]);
  const spanDoc = await PDFDocument.load(spanningPreview);
  is("the part on the kept pages is still tagged", spanDoc.catalog.has(PDFName.of("StructTreeRoot")), true);
  done();
}

/** The source with its first element's first marked-content number replaced. */
async function withFirstMcid(bytes: Uint8Array, mcid: number): Promise<Uint8Array> {
  const doc = await PDFDocument.load(bytes);
  const root = doc.catalog.lookup(PDFName.of("StructTreeRoot")) as PDFDict;
  const stack: PDFDict[] = [];
  const top = root.lookup(PDFName.of("K"));
  for (const kid of top instanceof PDFArray ? top.asArray() : [top]) {
    const value = doc.context.lookup(kid as PDFRef);
    if (value instanceof PDFDict) stack.push(value);
  }
  while (stack.length) {
    const element = stack.shift()!;
    const k = element.lookup(PDFName.of("K"));
    const kids = k instanceof PDFArray ? k.asArray() : k === undefined ? [] : [k];
    const at = kids.findIndex((kid) => kid instanceof PDFNumber);
    if (at >= 0) {
      if (k instanceof PDFArray) k.set(at, PDFNumber.of(mcid));
      else element.set(PDFName.of("K"), PDFNumber.of(mcid));
      return doc.save();
    }
    for (const kid of kids) {
      const value = doc.context.lookup(kid as PDFRef);
      if (value instanceof PDFDict) stack.push(value);
    }
  }
  throw new Error("no marked-content number in the source");
}

/** The source with one more element: a table over the first and third pages, its summary in its attributes. */
async function withSpanningTable(bytes: Uint8Array, summary: string): Promise<Uint8Array> {
  const doc = await PDFDocument.load(bytes);
  const root = doc.catalog.lookup(PDFName.of("StructTreeRoot")) as PDFDict;
  const pages = doc.getPages();
  const top = root.lookup(PDFName.of("K"));
  const holder = (top instanceof PDFArray ? doc.context.lookup(top.get(0) as PDFRef) : doc.context.lookup(top as PDFRef)) as PDFDict;
  const table = doc.context.obj({
    Type: "StructElem",
    S: "Table",
    P: root.get(PDFName.of("K")) instanceof PDFArray ? (top as PDFArray).get(0) : root.get(PDFName.of("K")),
    A: { O: "Table", Summary: PDFString.of(summary) },
    K: [doc.context.obj({ Type: "MCR", Pg: pages[0].ref, MCID: 0 }), doc.context.obj({ Type: "MCR", Pg: pages[2].ref, MCID: 0 })],
  });
  const kids = holder.lookup(PDFName.of("K"));
  const ref = doc.context.register(table);
  if (kids instanceof PDFArray) kids.push(ref);
  else holder.set(PDFName.of("K"), doc.context.obj(kids === undefined ? [ref] : [kids, ref]));
  return doc.save();
}

void main();
