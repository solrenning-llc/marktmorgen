/**
 * AX274 Part A, item 5: the PDFs the demo store hands a buyer are the site's
 * own files, so they follow PDF/UA and WCAG like any other PDF it makes:
 * tagged (ISO 14289-1 7.1), in a language (7.2), with the title shown (7.1),
 * the meal plan read as a table with its headers (7.5; WCAG 1.3.1), the
 * checklists as lists (7.6), text at 7:1 (WCAG 1.4.6) and the boxes and lines
 * to write on at 3:1 (1.4.11). Read the way a checker reads them: the
 * catalog, the structure tree and each page's drawing.
 */
import { PDFArray, PDFBool, PDFDict, PDFDocument, PDFName, PDFRawStream, type PDFRef, PDFString, decodePDFRawStream } from "pdf-lib";
import { getDemoFile, type DemoFileName } from "@/lib/demo-file";
import { done, is, part } from "./check";

const NAMES: DemoFileName[] = ["weekly-meal-planner.pdf", "meal-planner-5-weeks.pdf", "weekend-batch-cooking.pdf", "grocery-list-pack.pdf"];

type RGB = [number, number, number];
const lum = (c: RGB) => c.map((v) => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4)).reduce((a, v, i) => a + v * [0.2126, 0.7152, 0.0722][i], 0);
const ratio = (a: RGB, b: RGB) => (Math.max(lum(a), lum(b)) + 0.05) / (Math.min(lum(a), lum(b)) + 0.05);

function streamsOf(doc: PDFDocument, index: number): string {
  const raw = doc.getPages()[index].node.Contents();
  const refs = raw instanceof PDFArray ? raw.asArray() : [raw];
  return refs
    .map((ref) => {
      const s = doc.context.lookup(ref as PDFRef);
      return s instanceof PDFRawStream ? new TextDecoder("latin1").decode(decodePDFRawStream(s).decode()) : "";
    })
    .join("\n");
}

/** Walks one page's drawing: where each text sits (tagged, artifact or loose), its fill, what is behind it, and every stroke. */
function walk(stream: string): { loose: number; texts: { fill: RGB; ground: RGB }[]; strokes: RGB[] } {
  const tokens = stream.match(/\((?:\\.|[^\\)])*\)|<[0-9A-Fa-f]*>|\/[^\s/<>()[\]]+|<<|>>|[^\s/<>()[\]]+/g) ?? [];
  const stack: string[] = [];
  const bands: { x: number; y: number; w: number; h: number; fill: RGB }[] = [];
  let fill: RGB = [0, 0, 0];
  let x = 0;
  let y = 0;
  const args: string[] = [];
  const out = { loose: 0, texts: [] as { fill: RGB; ground: RGB }[], strokes: [] as RGB[] };
  let depth = 0;
  for (const token of tokens) {
    if (token === "<<") depth += 1;
    if (token === ">>") depth -= 1;
    if (depth > 0 || token === ">>") {
      args.push(token);
      continue;
    }
    const n = args.map(Number);
    switch (token) {
      case "BDC":
        stack.push(args[0] === "/Artifact" ? "artifact" : "tag");
        break;
      case "BMC":
        stack.push(args[0] === "/Artifact" ? "artifact" : "other");
        break;
      case "EMC":
        stack.pop();
        break;
      case "rg":
        fill = [n[0], n[1], n[2]];
        break;
      case "RG":
        out.strokes.push([n[0], n[1], n[2]]);
        break;
      case "re":
        bands.push({ x: n[0], y: n[1], w: n[2], h: n[3], fill });
        break;
      case "Td":
      case "TD":
        x = n[0];
        y = n[1];
        break;
      case "Tm":
        x = n[4];
        y = n[5];
        break;
      case "Tj":
      case "TJ": {
        const where = stack[stack.length - 1];
        if (where !== "tag" && where !== "artifact") out.loose += 1;
        if (where !== "artifact") {
          const under = [...bands].reverse().find((b) => b.w > 20 && x >= b.x && x <= b.x + b.w && y >= b.y && y <= b.y + b.h);
          out.texts.push({ fill, ground: under ? under.fill : [1, 1, 1] });
        }
        break;
      }
      default:
        if (/^[A-Za-z'"*]+$/.test(token)) args.length = 0;
        else args.push(token);
        continue;
    }
    args.length = 0;
  }
  return out;
}

function kidsOf(doc: PDFDocument, dict: PDFDict): PDFDict[] {
  const k = dict.lookup(PDFName.of("K"));
  return k instanceof PDFArray ? k.asArray().map((ref) => doc.context.lookup(ref, PDFDict)) : [];
}
const roleOf = (d: PDFDict) => d.lookup(PDFName.of("S"), PDFName).asString().slice(1);
function roles(doc: PDFDocument, dict: PDFDict): string[] {
  return kidsOf(doc, dict).flatMap((kid) => [roleOf(kid), ...roles(doc, kid)]);
}

async function main(): Promise<void> {
  for (const name of NAMES) {
    part(name);
    const doc = await PDFDocument.load(getDemoFile(name));
    const catalog = doc.catalog;
    const root = catalog.lookup(PDFName.of("StructTreeRoot"));
    is(`${name}: has a structure tree and says it is tagged`, [
      root instanceof PDFDict,
      (catalog.lookup(PDFName.of("MarkInfo")) as PDFDict | undefined)?.get(PDFName.of("Marked"))?.toString() ?? null,
    ], [true, "true"]);
    const lang = catalog.lookup(PDFName.of("Lang"));
    is(`${name}: says its language`, lang instanceof PDFString ? lang.decodeText() : null, "en-US");
    const prefs = catalog.lookup(PDFName.of("ViewerPreferences"));
    is(`${name}: shows its title, not its file name`, prefs instanceof PDFDict ? (prefs.get(PDFName.of("DisplayDocTitle")) as PDFBool | undefined)?.asBoolean() ?? null : null, true);
    const pages = doc.getPages().map((_, i) => walk(streamsOf(doc, i)));
    is(`${name}: no text outside the structure or an artifact, on any page`, pages.map((p) => p.loose), pages.map(() => 0));
    const dim = pages.flatMap((p) => p.texts).filter((t) => ratio(t.fill, t.ground) < 7).length;
    is(`${name}: every piece of text reads at 7:1 on what is behind it`, dim, 0);
    const faint = pages.flatMap((p) => p.strokes).filter((c) => ratio(c, [1, 1, 1]) < 3).length;
    is(`${name}: every box and line drawn reads at 3:1 on the page`, faint, 0);
    if (!(root instanceof PDFDict)) continue;
    const document = root.lookup(PDFName.of("K"), PDFDict);
    const all = roles(doc, document);
    is(`${name}: starts with its title as a first-level heading`, all[0], "H1");
    if (name.includes("planner")) {
      is(`${name}: the week is a table with column headers and a header for each day`, [all.includes("Table"), all.includes("TR"), all.includes("TH"), all.includes("TD")], [true, true, true, true]);
    }
    if (name === "grocery-list-pack.pdf" || name.includes("planner")) {
      is(`${name}: its checklist is a list`, [all.includes("L"), all.includes("LI"), all.includes("LBody")], [true, true, true]);
    }
  }
  done();
}

void main();
