/**
 * A PDF a screen reader can read (630 [HN6](8), unit 1; AX274 asks every
 * PDF the site makes to follow PDF/UA): what is drawn is wrapped in marked
 * content, each piece of text tied to an element of a structure tree (a
 * heading, a paragraph) in reading order, and every line, frame or seal that
 * only decorates is marked as an artifact, so it is skipped. The file says its
 * language, shows its title instead of its file name, and carries the PDF/UA
 * identification in its XMP metadata.
 *
 * Built on pdf-lib's own operators; nothing is fetched or paid for. This
 * writes what PDF/UA asks of a file's structure; it does not, by itself,
 * prove a file conforms: that takes a checker such as veraPDF and a reading
 * with a real screen reader, which stay to be done.
 */
import {
  type PDFDocument,
  PDFHexString,
  PDFName,
  PDFNumber,
  PDFOperator,
  PDFOperatorNames,
  type PDFPage,
  type PDFRef,
  PDFString,
} from "pdf-lib";

/** The structure roles this file writes (ISO 32000-1, 14.8.4). */
export type TagRole = "H1" | "H2" | "P";

type Tagged = { role: TagRole; mcid: number; page: number; actualText?: string };

function xml(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

/** The XMP packet: title, author, producer, dates and the PDF/UA part. */
export function xmpPacket(meta: { title: string; author: string; producer: string; at: Date; lang: string }): string {
  const when = meta.at.toISOString().replace(/\.\d{3}Z$/, "Z");
  return [
    '<?xpacket begin="﻿" id="W5M0MpCehiHzreSzNTczkc9d"?>',
    '<x:xmpmeta xmlns:x="adobe:ns:meta/">',
    '<rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#">',
    '<rdf:Description rdf:about="" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:pdf="http://ns.adobe.com/pdf/1.3/" xmlns:xmp="http://ns.adobe.com/xap/1.0/" xmlns:pdfuaid="http://www.aiim.org/pdfua/ns/id/">',
    `<dc:title><rdf:Alt><rdf:li xml:lang="x-default">${xml(meta.title)}</rdf:li></rdf:Alt></dc:title>`,
    `<dc:creator><rdf:Seq><rdf:li>${xml(meta.author)}</rdf:li></rdf:Seq></dc:creator>`,
    `<dc:language><rdf:Bag><rdf:li>${xml(meta.lang)}</rdf:li></rdf:Bag></dc:language>`,
    `<pdf:Producer>${xml(meta.producer)}</pdf:Producer>`,
    `<xmp:CreatorTool>${xml(meta.producer)}</xmp:CreatorTool>`,
    `<xmp:CreateDate>${when}</xmp:CreateDate>`,
    `<xmp:ModifyDate>${when}</xmp:ModifyDate>`,
    "<pdfuaid:part>1</pdfuaid:part>",
    "</rdf:Description>",
    "</rdf:RDF>",
    "</x:xmpmeta>",
    '<?xpacket end="w"?>',
  ].join("\n");
}

/**
 * Tags a document, one page or several. Draw through `text` and `artifact` in
 * reading order; `nextPage` moves on to a page added after the first (639
 * [GL7](26): a form's answers can run over several); call `finish` once,
 * before saving.
 */
export class PageTagger {
  private readonly items: Tagged[] = [];
  private readonly pages: PDFPage[];
  private mcids = 0;

  constructor(
    private readonly pdf: PDFDocument,
    page: PDFPage,
  ) {
    this.pages = [page];
  }

  private get page(): PDFPage {
    return this.pages[this.pages.length - 1];
  }

  /** From here on, what is drawn is on this page (one added to the document after the last). */
  nextPage(page: PDFPage): void {
    this.pages.push(page);
    this.mcids = 0;
  }

  /** Draws something a reader reads, as one element of `role`. `actualText` replaces what is drawn (a shortened line). */
  text(role: TagRole, draw: () => void, actualText?: string): void {
    const mcid = this.mcids++;
    // An inline property list, `<< /MCID n >>`: pdf-lib writes a dictionary operand as it writes any object.
    const props = this.pdf.context.obj({ MCID: mcid }) as unknown as PDFName;
    this.page.pushOperators(PDFOperator.of(PDFOperatorNames.BeginMarkedContentSequence, [PDFName.of(role), props]));
    draw();
    this.page.pushOperators(PDFOperator.of(PDFOperatorNames.EndMarkedContent));
    this.items.push({ role, mcid, page: this.pages.length - 1, ...(actualText ? { actualText } : {}) });
  }

  /** What the last element is read as, when what was drawn is shorter (a line cut with an ellipsis). */
  retext(full: string): void {
    const last = this.items[this.items.length - 1];
    if (last) last.actualText = full;
  }

  /** Draws something that only decorates: a reader skips it. */
  artifact(draw: () => void): void {
    this.page.pushOperators(PDFOperator.of(PDFOperatorNames.BeginMarkedContent, [PDFName.of("Artifact")]));
    draw();
    this.page.pushOperators(PDFOperator.of(PDFOperatorNames.EndMarkedContent));
  }

  /** Writes the structure tree, the language, the title shown and the XMP metadata. */
  finish(meta: { title: string; author: string; producer: string; lang: string; at: Date }): void {
    const { context, catalog } = this.pdf;
    const rootRef = context.nextRef();
    const documentRef = context.nextRef();
    const elements: PDFRef[] = this.items.map((item) =>
      context.register(
        context.obj({
          Type: "StructElem",
          S: item.role,
          P: documentRef,
          Pg: this.pages[item.page].ref,
          K: item.mcid,
          ...(item.actualText ? { ActualText: PDFHexString.fromText(item.actualText) } : {}),
        }),
      ),
    );
    context.assign(documentRef, context.obj({ Type: "StructElem", S: "Document", P: rootRef, Lang: PDFString.of(meta.lang), K: elements }));
    // Each page's marked content, by its number: page i's elements in the order of their MCIDs.
    const nums = this.pages.flatMap((_, i) => [PDFNumber.of(i), context.obj(elements.filter((_, at) => this.items[at].page === i))]);
    const parentTree = context.register(context.obj({ Nums: nums }));
    context.assign(rootRef, context.obj({ Type: "StructTreeRoot", K: documentRef, ParentTree: parentTree, ParentTreeNextKey: this.pages.length }));
    catalog.set(PDFName.of("StructTreeRoot"), rootRef);
    catalog.set(PDFName.of("MarkInfo"), context.obj({ Marked: true, Suspects: false }));
    catalog.getOrCreateViewerPreferences().setDisplayDocTitle(true);
    this.pages.forEach((page, i) => {
      page.node.set(PDFName.of("StructParents"), PDFNumber.of(i));
      page.node.set(PDFName.of("Tabs"), PDFName.of("S"));
    });
    this.pdf.setLanguage(meta.lang);
    this.pdf.setTitle(meta.title, { showInWindowTitleBar: true });
    this.pdf.setAuthor(meta.author);
    this.pdf.setCreator(meta.producer);
    this.pdf.setProducer(meta.producer);
    this.pdf.setCreationDate(meta.at);
    this.pdf.setModificationDate(meta.at);
    const packet = new TextEncoder().encode(xmpPacket(meta));
    const metadata = context.stream(packet, { Type: "Metadata", Subtype: "XML", Length: packet.length });
    catalog.set(PDFName.of("Metadata"), context.register(metadata));
  }
}
