/**
 * A store page as a file, and a file brought back as a page (582 [KB3], unit
 * 3; added 10 November 2026): "Download as a file" saves one of the store's
 * own pages to the creator's computer, and "Bring in a page from a file" makes
 * a new page from such a file, in this store or another of theirs. A copy to
 * keep, to move, or to start the next store from, without building it again.
 *
 * What the file holds: the page's title and its blocks, in order, with every
 * word and video, and its style. Not its pictures (each belongs to one page
 * of one store, and is deleted with it), not its search title and line, not
 * its earlier versions. It is plain JSON the creator can open and read; it
 * holds no address, buyer, order or number of the store's.
 *
 * What a page brought in is:
 *
 *   - a new page after the others, kept back from visitors and out of the
 *     menu until the creator shows it, at an address made from its title;
 *   - read by the same rules as a page the editor saves (parsePage and
 *     pageProblem in lib/sales-page.ts): a file whose blocks would not be
 *     kept as they are is refused whole, never kept cut short;
 *   - with each product, form or call it names that is not this store's left
 *     out and counted, the same way a store copy leaves them out
 *     (copiedBlocks in lib/store-copy-rules.ts), and the reviews picked to
 *     show first left out, since they are another store's buyers'.
 *
 * Pure: the route reads, checks and writes.
 */
import { EMPTY_PAGE, type PageBlock, type PageStyle, type SalesPage, copyOfPage, pageProblem, parsePage } from "@/lib/sales-page";
import { type BlocksLeft, copiedBlocks, emptyBlocksLeft } from "@/lib/store-copy-rules";
import { SITE_KINDS, type SitePage, siteTitle, slugFrom, slugProblem } from "@/lib/site-page-rules";

export const PAGE_FILE_FORMAT = "marktmorgen-store-page";
export const PAGE_FILE_VERSION = 1;

export type PageFile = {
  format: typeof PAGE_FILE_FORMAT;
  version: typeof PAGE_FILE_VERSION;
  title: string;
  blocks: PageBlock[];
  style: PageStyle;
};

/** The file of one page: its title, its blocks without their pictures, its style; and how many pictures were left out. */
export function pageFile(entry: SitePage, page: SalesPage): { file: PageFile; pictures: number } {
  const { blocks, picturesLeft, style } = copyOfPage(page);
  return { file: { format: PAGE_FILE_FORMAT, version: PAGE_FILE_VERSION, title: entry.title, blocks, style }, pictures: picturesLeft };
}

/** The name the downloaded file is given: the page's address, then ".page.json". */
export const pageFileName = (entry: Pick<SitePage, "slug">) => `${entry.slug || "page"}.page.json`;

export type ReadFile = { ok: true; title: string; page: SalesPage } | { ok: false; reason: "file" | "too_big" | "kind" };

/**
 * A file as sent, read by the rules a saved page is held to. Refused when it
 * is not one of these files, when its blocks would not be kept as they are,
 * or when it holds a kind of block a store's own page cannot have.
 */
export function readPageFile(raw: unknown): ReadFile {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return { ok: false, reason: "file" };
  const value = raw as Record<string, unknown>;
  if (value.format !== PAGE_FILE_FORMAT || value.version !== PAGE_FILE_VERSION || !Array.isArray(value.blocks)) return { ok: false, reason: "file" };
  const sent = { blocks: value.blocks, style: value.style };
  const page = { ...parsePage({ ...sent, test: null, variant: null, next: null }), test: null, variant: null, next: null };
  const problem = pageProblem(sent, page);
  if (problem === "too_big") return { ok: false, reason: "too_big" };
  if (problem) return { ok: false, reason: "file" };
  if (page.blocks.some((block) => !SITE_KINDS.includes(block.kind))) return { ok: false, reason: "kind" };
  return { ok: true, title: siteTitle(value.title), page };
}

/** The forms a page's blocks name, to be checked against the store's own. */
export function formsNamed(page: Pick<SalesPage, "blocks">): string[] {
  return [...new Set(page.blocks.flatMap((block) => (block.kind === "form" && block.form ? [block.form] : [])))];
}

/**
 * The page brought in: the file's blocks with what is not this store's left
 * out (products, forms and calls it does not have, pictures, picked reviews),
 * kept back from visitors, with fresh block ids; and what was left out.
 */
export function importedPage(page: SalesPage, isProduct: (id: string) => boolean, isForm: (id: string) => boolean): { page: SalesPage; left: BlocksLeft } {
  const left = emptyBlocksLeft();
  const kept = copiedBlocks(page.blocks, (id) => (isProduct(id) ? id : ""), (id) => (isForm(id) ? id : ""), left);
  const { blocks } = copyOfPage({ ...page, blocks: kept });
  return { page: parsePage({ ...EMPTY_PAGE, blocks, style: page.style, hidden: true }), left };
}

/** The page's place in the list: its title (or "Page from a file"), at an address made from it, numbered when taken. */
export function importedEntry(title: string, pages: readonly SitePage[], id: string): SitePage | null {
  const name = title || "Page from a file";
  const base = slugFrom(name) || "page";
  for (let n = 1; n <= 20; n++) {
    const slug = n === 1 ? base : `${base.slice(0, 36)}-${n}`;
    if (slugProblem(slug, pages) === null) return { id, slug, title: name, nav: false, target: "", from: -1 };
  }
  return null;
}
