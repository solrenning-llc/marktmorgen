/**
 * "Make a copy" of one of the store's own pages (582 [KB3], unit 2; added 10
 * November 2026): a second page with the same blocks and words, in the same
 * order, for a variant, a seasonal version or a second offer, without
 * building it again block by block.
 *
 * What the copy is:
 *
 *   - a new page of the store's list, after the others, named "Copy of …"
 *     at the address "<address>-copy" ("-copy-2", "-copy-3"… when taken),
 *     never longer than a title or an address may be;
 *   - kept back from visitors and out of the menu at the top of the store,
 *     until the creator chooses to show it: nothing new appears on the store
 *     by itself;
 *   - with every block, in order, and every word, video, product, form and
 *     review choice of the original, all of this store's own.
 *
 * What it never takes: the pictures. Each picture belongs to one page only
 * (claimNewPictures in lib/sales-page-store.ts), and it is deleted with that
 * page, so a copy never shows a picture the original may take away. A
 * pictures block stays in place, empty, for the creator to fill again; a
 * picture beside words and a picture in a row are left out. The studio says
 * so before the copy is made, and how many were left out after.
 *
 * Nor its search title and line, so two pages never claim the same words to a
 * search engine; the creator writes the copy's own. The blocks are made by
 * copyOfPage (lib/sales-page.ts), the same start a product's page is given
 * from another, with fresh block ids.
 *
 * Pure: the route reads, checks and writes.
 */
import { EMPTY_PAGE, type SalesPage, copyOfPage } from "@/lib/sales-page";
import { MAX_SITE_TITLE, MAX_SLUG, type SitePage, slugProblem } from "@/lib/site-page-rules";

export const COPY_TITLE_PREFIX = "Copy of ";

/** "Copy of <title>", never longer than a page's title may be, and never "Copy of Copy of". */
export function pageCopyTitle(title: string): string {
  let base = title.trim();
  while (/^copy of(\s|$)/i.test(base)) base = base.slice(COPY_TITLE_PREFIX.length - 1).trimStart();
  return `${COPY_TITLE_PREFIX}${(base || "page").slice(0, MAX_SITE_TITLE - COPY_TITLE_PREFIX.length).trimEnd()}`;
}

/**
 * The copy's address: "<address>-copy", then "-copy-2", "-copy-3"… until one
 * is free, never longer than an address may be. Null when none of the first
 * twenty is free (a store holds ten pages, so that is never reached).
 */
export function pageCopySlug(slug: string, pages: readonly SitePage[]): string | null {
  const base = slug.replace(/-copy(-\d+)?$/, "") || "page";
  for (let n = 1; n <= 20; n++) {
    const end = n === 1 ? "-copy" : `-copy-${n}`;
    const candidate = `${base.slice(0, MAX_SLUG - end.length).replace(/-+$/, "")}${end}`;
    if (slugProblem(candidate, pages) === null) return candidate;
  }
  return null;
}

/**
 * The copy, ready to write: its entry in the store's list (with its new id)
 * and its page, kept back, or null when no address is free.
 */
export function pageCopy(source: SitePage, page: SalesPage, pages: readonly SitePage[], id: string): { entry: SitePage; page: SalesPage; pictures: number } | null {
  const slug = pageCopySlug(source.slug, pages);
  if (!slug) return null;
  // The same start a product's page is given from another (copyOfPage): fresh block ids, pictures left out.
  const { blocks, picturesLeft, style } = copyOfPage(page);
  return {
    entry: { id, slug, title: pageCopyTitle(source.title), nav: false, target: source.target, from: -1 },
    page: { ...EMPTY_PAGE, blocks, style, hidden: true },
    pictures: picturesLeft,
  };
}
