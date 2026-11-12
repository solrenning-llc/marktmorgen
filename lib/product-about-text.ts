/**
 * How a product's long description is read and drawn (lib/product-about.ts
 * keeps it): pure text functions only, with no store or database code, so the
 * studio's product and page editors can draw a preview without carrying
 * lib/store-data.ts and what it reaches (tests/client-bundles.mjs).
 */
/** Room for a proper sales page, and still something a person reads. */
export const MAX_ABOUT_LENGTH = 5_000;

/** Normalises what was typed: line endings, trailing space, and the length. */
export function cleanAbout(raw: string, max = MAX_ABOUT_LENGTH): string {
  return raw
    .replace(/\r\n?/g, "\n")
    .split("\n")
    .map((line) => line.replace(/\s+$/, ""))
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim()
    .slice(0, max);
}

/** A run of text, or an address to link to. */
export type Piece = { text: string; href?: string };

/** One block of a description: a paragraph of lines, or a list of points. */
export type Block = { kind: "paragraph"; lines: Piece[][] } | { kind: "list"; items: Piece[][] };

/**
 * Finds the web addresses in a line and makes them links.
 *
 * Only https and http, only addresses written out in full, and the full stop
 * or bracket that ends a sentence is left outside the link. The address the
 * link goes to is exactly the text the reader sees, so a link can never say
 * one place and go to another.
 */
export function linkPieces(line: string): Piece[] {
  const pieces: Piece[] = [];
  const pattern = /\bhttps?:\/\/[^\s<>"]+/gi;
  let last = 0;
  for (const match of line.matchAll(pattern)) {
    let url = match[0];
    // Counted from the end in one pass: an anchored pattern would take time
    // growing with the square of a long run of these that stops short of it.
    let cut = 0;
    while (cut < url.length && ".,;:!?)]}'’".includes(url[url.length - 1 - cut])) cut += 1;
    if (cut) url = url.slice(0, url.length - cut);
    const start = match.index ?? 0;
    let valid = false;
    try {
      const parsed = new URL(url);
      valid = (parsed.protocol === "https:" || parsed.protocol === "http:") && !parsed.username && !parsed.password;
    } catch {
      valid = false;
    }
    if (!valid) continue;
    if (start > last) pieces.push({ text: line.slice(last, start) });
    pieces.push({ text: url, href: url });
    last = start + url.length;
  }
  if (last < line.length) pieces.push({ text: line.slice(last) });
  return pieces;
}

/** Cuts a description into the blocks the product page draws. */
export function aboutBlocks(text: string, max = MAX_ABOUT_LENGTH): Block[] {
  const blocks: Block[] = [];
  for (const chunk of cleanAbout(text, max).split(/\n\s*\n/)) {
    const lines = chunk.split("\n").filter((line) => line.trim() !== "");
    if (lines.length === 0) continue;
    let paragraph: Piece[][] = [];
    let list: Piece[][] = [];
    const flush = () => {
      if (paragraph.length) blocks.push({ kind: "paragraph", lines: paragraph });
      if (list.length) blocks.push({ kind: "list", items: list });
      paragraph = [];
      list = [];
    };
    for (const line of lines) {
      const point = /^\s*(?:[-*•])\s+(.*)$/.exec(line);
      if (point) {
        if (paragraph.length) {
          blocks.push({ kind: "paragraph", lines: paragraph });
          paragraph = [];
        }
        list.push(linkPieces(point[1]));
      } else {
        if (list.length) {
          blocks.push({ kind: "list", items: list });
          list = [];
        }
        paragraph.push(linkPieces(line.trim()));
      }
    }
    flush();
  }
  return blocks;
}

/** The first sentence or so, for a search result or a shared link. */
export function aboutExcerpt(text: string, max = 160, length = MAX_ABOUT_LENGTH): string {
  const flat = cleanAbout(text, length).replace(/^\s*[-*•]\s+/gm, "").replace(/\s+/g, " ").trim();
  if (flat.length <= max) return flat;
  const cut = flat.slice(0, max - 1);
  return `${cut.slice(0, Math.max(cut.lastIndexOf(" "), max - 20))}…`;
}
