/**
 * What a preview of a creator's PDF keeps of what makes it readable (AX274
 * Part A, item 5; PDF/UA, ISO 14289-1 7.1 and 7.2). lib/pdf-preview.ts copies
 * the first pages into a new file, which carries their drawing but not the
 * document's language, its "show the title" preference or its structure tree.
 * This adds them back:
 *
 * - the language and the title shown, always;
 * - when the source is tagged, a new structure tree holding only what the kept
 *   pages draw: each element rebuilt from plain values (role, language,
 *   alternate and replacement text, attributes made only of names, numbers
 *   and strings), its page pointed at the copied page, its marked content
 *   tied to it through a new parent tree.
 *
 * Nothing of a page left out may reach the preview, which a visitor gets for
 * free: pdf-lib writes every object a file holds, so nothing of the source's
 * tree is copied by reference. An element with any content on a page left
 * out is kept only for the part on the kept pages, and loses its alternate
 * and replacement text, which may describe the rest. Links to annotations
 * (OBJR) and marked content in other streams are not carried; the annotations
 * on the kept pages lose their now unused StructParent.
 */
import {
  PDFArray,
  PDFBool,
  PDFDict,
  type PDFDocument,
  PDFHexString,
  PDFName,
  PDFNull,
  PDFNumber,
  type PDFObject,
  type PDFPage,
  PDFRef,
  PDFString,
} from "pdf-lib";

/** The entries copied from an element when all its content is kept; only its role and language otherwise. */
const TEXT_KEYS = ["Alt", "ActualText", "E", "T"];

/** A plain value, rebuilt in `into`: names, numbers, booleans, strings, and arrays and dictionaries of them. Anything else is null. */
function plainCopy(value: PDFObject | undefined, into: PDFDocument, depth = 0): PDFObject | null {
  if (value === undefined || depth > 4) return null;
  if (value instanceof PDFName || value instanceof PDFNumber || value instanceof PDFBool) return value;
  if (value instanceof PDFString) return PDFString.of(value.asString());
  if (value instanceof PDFHexString) return PDFHexString.of(value.asString());
  if (value instanceof PDFArray) {
    const items = value.asArray().map((item) => plainCopy(item, into, depth + 1));
    return items.every((item) => item !== null) ? into.context.obj(items as PDFObject[]) : null;
  }
  if (value instanceof PDFDict) {
    const out = into.context.obj({});
    for (const [key, item] of value.entries()) {
      const copied = plainCopy(item, into, depth + 1);
      if (copied === null) return null;
      out.set(key, copied);
    }
    return out;
  }
  return null;
}

/**
 * Carries the language, the title shown and, from a tagged source, the kept
 * pages' structure into `out`. `kept[i]` is the source page whose copy is
 * page i of `out`. Never throws: a tree it cannot read is left out, and the
 * preview stays untagged as before.
 */
export function carryTags(source: PDFDocument, out: PDFDocument, kept: PDFPage[]): void {
  const lang = source.catalog.lookup(PDFName.of("Lang"));
  if (lang instanceof PDFString || lang instanceof PDFHexString) out.setLanguage(lang.decodeText());
  out.catalog.getOrCreateViewerPreferences().setDisplayDocTitle(true);
  try {
    carryTree(source, out, kept);
  } catch {
    out.catalog.delete(PDFName.of("StructTreeRoot"));
    out.catalog.delete(PDFName.of("MarkInfo"));
  }
}

function carryTree(source: PDFDocument, out: PDFDocument, kept: PDFPage[]): void {
  const root = source.catalog.lookup(PDFName.of("StructTreeRoot"));
  const mark = source.catalog.lookup(PDFName.of("MarkInfo"));
  if (!(root instanceof PDFDict) || !(mark instanceof PDFDict) || mark.get(PDFName.of("Marked"))?.toString() !== "true") return;
  const copies = out.getPages();
  const pageOf = new Map<PDFRef, number>();
  kept.forEach((page, i) => pageOf.set(page.ref, i));
  // For each page of the preview, the element that holds each MCID.
  const owners: PDFRef[][] = copies.map(() => []);
  const seen = new Set<PDFDict>();

  /** The rebuilt element, or null when nothing of it is on a kept page; `whole` says whether every part of it was. */
  const rebuild = (element: PDFDict, parent: PDFRef, inheritedPage: number | null | undefined): { ref: PDFRef; whole: boolean } | null => {
    if (seen.has(element)) return null;
    seen.add(element);
    const role = element.lookup(PDFName.of("S"));
    if (!(role instanceof PDFName)) return null;
    const ref = out.context.nextRef();
    const pgRef = element.get(PDFName.of("Pg"));
    const page = pgRef instanceof PDFRef ? (pageOf.get(pgRef) ?? null) : inheritedPage;
    const raw = element.lookup(PDFName.of("K"));
    const kids: PDFObject[] = raw === undefined ? [] : raw instanceof PDFArray ? raw.asArray() : [raw];
    const outKids: PDFObject[] = [];
    let whole = true;
    for (const kid of kids) {
      const value = kid instanceof PDFRef ? source.context.lookup(kid) : kid;
      if (value instanceof PDFNumber) {
        if (page === null || page === undefined) whole = false;
        else {
          outKids.push(value);
          owners[page][value.asNumber()] = ref;
        }
      } else if (value instanceof PDFDict && value.lookup(PDFName.of("Type"))?.toString() === "/MCR") {
        const mcrPg = value.get(PDFName.of("Pg"));
        const at = mcrPg instanceof PDFRef ? (pageOf.get(mcrPg) ?? null) : page;
        const mcid = value.lookup(PDFName.of("MCID"));
        if (at === null || at === undefined || !(mcid instanceof PDFNumber) || value.has(PDFName.of("Stm"))) whole = false;
        else {
          outKids.push(out.context.obj({ Type: "MCR", Pg: copies[at].ref, MCID: mcid }));
          owners[at][mcid.asNumber()] = ref;
        }
      } else if (value instanceof PDFDict && value.has(PDFName.of("S"))) {
        const child = rebuild(value, ref, page);
        if (child) {
          outKids.push(child.ref);
          whole &&= child.whole;
        } else whole = false;
      } else {
        // An annotation's link (OBJR) or something unknown: not carried.
        whole = false;
      }
    }
    if (outKids.length === 0) return null;
    const dict = out.context.obj({ Type: "StructElem", S: role, P: parent, K: outKids });
    if (page !== null && page !== undefined && pgRef instanceof PDFRef) dict.set(PDFName.of("Pg"), copies[page].ref);
    const elementLang = plainCopy(element.lookup(PDFName.of("Lang")), out);
    if (elementLang) dict.set(PDFName.of("Lang"), elementLang);
    const attributes = plainCopy(element.lookup(PDFName.of("A")), out);
    if (attributes) dict.set(PDFName.of("A"), attributes);
    if (whole) {
      for (const key of TEXT_KEYS) {
        const text = plainCopy(element.lookup(PDFName.of(key)), out);
        if (text) dict.set(PDFName.of(key), text);
      }
    }
    out.context.assign(ref, dict);
    return { ref, whole };
  };

  const rootRef = out.context.nextRef();
  const top = root.lookup(PDFName.of("K"));
  const topKids: PDFObject[] = top === undefined ? [] : top instanceof PDFArray ? top.asArray() : [top];
  const children: PDFRef[] = [];
  for (const kid of topKids) {
    const value = kid instanceof PDFRef ? source.context.lookup(kid) : kid;
    if (value instanceof PDFDict) {
      const child = rebuild(value, rootRef, undefined);
      if (child) children.push(child.ref);
    }
  }
  if (children.length === 0) return;
  const nums: PDFObject[] = [];
  copies.forEach((page, i) => {
    nums.push(PDFNumber.of(i), out.context.obj(Array.from({ length: owners[i].length }, (_, mcid) => owners[i][mcid] ?? PDFNull)));
    page.node.set(PDFName.of("StructParents"), PDFNumber.of(i));
    page.node.set(PDFName.of("Tabs"), PDFName.of("S"));
    const annots = page.node.lookup(PDFName.of("Annots"));
    if (annots instanceof PDFArray) {
      for (const annot of annots.asArray()) {
        const dict = annot instanceof PDFRef ? out.context.lookup(annot) : annot;
        if (dict instanceof PDFDict) dict.delete(PDFName.of("StructParent"));
      }
    }
  });
  const parentTree = out.context.register(out.context.obj({ Nums: nums }));
  const newRoot = out.context.obj({ Type: "StructTreeRoot", K: children.length === 1 ? children[0] : children, ParentTree: parentTree, ParentTreeNextKey: copies.length });
  const roleMap = plainCopy(root.lookup(PDFName.of("RoleMap")), out);
  if (roleMap) newRoot.set(PDFName.of("RoleMap"), roleMap);
  out.context.assign(rootRef, newRoot);
  out.catalog.set(PDFName.of("StructTreeRoot"), rootRef);
  out.catalog.set(PDFName.of("MarkInfo"), out.context.obj({ Marked: true }));
}
