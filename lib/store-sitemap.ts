/**
 * A store's own map for search engines, and its own rules for crawlers
 * (added 13 October 2026).
 *
 * A store's pages were findable only by following links to them. On a
 * creator's own domain that was worse than it sounds: the domain answered
 * /sitemap.xml and /robots.txt with this site's, which name marktmorgen.com,
 * so the search console a creator opens for their own domain was told the
 * map was somebody else's. Every site builder a creator compares this with
 * makes one per site.
 *
 * What is listed is what the pages themselves tell a search engine to keep,
 * at the address each names as its own (its canonical): the front page while
 * it has something on it, every product a visitor can see, every page of the
 * store that is out, the blog and each published post. Nothing a store keeps
 * back, nothing of a store switched off after notices, and nothing behind a
 * purchase. On a creator's live domain the addresses are the short ones the
 * domain serves; otherwise they are under marktmorgen.com/@handle.
 *
 *   /@handle/sitemap.xml   on every store, and /sitemap.xml on its own domain
 *                          (app/[handle]/store-sitemap, reached through proxy.ts)
 *   /robots.txt            on its own domain only (app/[handle]/store-robots)
 */
import { canUseDomain } from "@/lib/domains";
import { KIND, readListings, visibleCount } from "@/lib/catalog";
import { collectionSegment, shownCollections } from "@/lib/store-collections";
import { productSegment } from "@/lib/product-slug";
import { pageOut } from "@/lib/site-page-rules";
import { POSTS_PER_PAGE, postSegment, publishedPosts, publishedTotal } from "@/lib/store-blog";
import { type SitemapSize, sitemapUnits } from "@/lib/public-read-rules";
import { takePublicRequest } from "@/lib/traffic";
import { SITE_URL } from "@/lib/site-url";
import type { Store } from "@/lib/store";

/** The most posts listed: far past what a store's blog holds. */
export const MAX_POSTS = 1_000;
/** The most pages of posts read for them. */
export const MAX_POST_PAGES = Math.ceil(MAX_POSTS / POSTS_PER_PAGE);

/** The products a visitor can see, in the creator's order: the ones the map names. */
function visibleIds(store: Store): string[] {
  return store.catalog.items.filter((item) => (item.kind & KIND.hidden) === 0).map((item) => item.id);
}

/**
 * What drawing the map reads, counted before it is read (4 November 2026,
 * lib/public-read-rules.ts): the visible products, from the record itself,
 * those whose listing it does not carry (read) apart from those it does (a
 * line of the answer each, nothing read), and the pages of published posts,
 * from one count. Null when the posts cannot be counted.
 */
export async function sitemapSize(store: Store): Promise<SitemapSize | null> {
  const total = await publishedTotal(store.statsId);
  if (total === null) return null;
  const visible = visibleIds(store);
  const carried = new Set(store.catalog.inline ? visible : store.catalog.head.map((listing) => listing.id));
  const listings = visible.filter((id) => !carried.has(id)).length;
  return { listings, carried: visible.length - listings, postPages: Math.min(MAX_POST_PAGES, Math.ceil(total / POSTS_PER_PAGE)) };
}

/**
 * The map, paid for first: sitemapUnits of the store's public requests,
 * taken before any listing or post is read, and no more pages of posts read
 * than were paid for. Null when the window has no room for it (or it cannot
 * be counted), and then nothing more is read.
 */
export async function paidStoreSitemap(store: Store, now = Date.now()): Promise<SitemapEntry[] | null> {
  if (store.suspended) return [];
  const size = await sitemapSize(store);
  if (!size) return null;
  if (!(await takePublicRequest(store, "public", now, sitemapUnits(size)))) return null;
  return storeSitemap(store, Math.floor(now / 1000), size.postPages).catch(() => null);
}

export type SitemapEntry = { url: string; lastModified?: string };

/** The store's own address, with no slash at its end: its live domain, or its address here. */
export function storeRoot(store: Store): string {
  return store.domain?.liveAt && canUseDomain(store) ? `https://${store.domain.name}` : `${SITE_URL}/@${store.handle}`;
}

/** Every address of a store a search engine is asked to keep, in the order a visitor meets them. */
export async function storeSitemap(store: Store, nowSeconds = Math.floor(Date.now() / 1000), postPages = MAX_POST_PAGES): Promise<SitemapEntry[]> {
  if (store.suspended) return [];
  const root = storeRoot(store);
  const own = root !== `${SITE_URL}/@${store.handle}`;
  const out: SitemapEntry[] = [];
  // The front page asks to be kept once it has something on it (app/[handle]/page.tsx).
  if (visibleCount(store) > 0 || store.links.length > 0) out.push({ url: own ? `${root}/` : root });
  // Only the products a visitor can see are read; the hidden ones are known from the record.
  for (const product of await readListings(store, visibleIds(store))) {
    if (product.hidden) continue;
    out.push({ url: `${root}/p/${productSegment(product)}` });
  }
  // The creator's collections with something published in them (lib/store-collections.ts).
  const items = store.catalog.items.map((item) => ({ id: item.id, hidden: (item.kind & KIND.hidden) !== 0 }));
  for (const { collection } of shownCollections(store.collections ?? [], items)) out.push({ url: `${root}/shop/${collectionSegment(collection)}` });
  for (const page of store.sitePages) {
    if (pageOut(page, nowSeconds)) out.push({ url: `${root}/${page.slug}` });
  }
  const posts = [];
  for (let page = 1; posts.length < MAX_POSTS && page <= Math.min(postPages, MAX_POST_PAGES); page += 1) {
    const { posts: some, total } = await publishedPosts(store.statsId, page);
    posts.push(...some);
    if (!some.length || page * POSTS_PER_PAGE >= total) break;
  }
  if (posts.length) {
    out.push({ url: `${root}/blog`, lastModified: new Date(Math.max(...posts.map((p) => p.updatedAt)) * 1000).toISOString() });
    for (const post of posts) out.push({ url: `${root}/blog/${postSegment(post)}`, lastModified: new Date(post.updatedAt * 1000).toISOString() });
  }
  return out;
}

const escape = (value: string) => value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&apos;");

/** The map, as search engines read it. */
export function sitemapXml(entries: SitemapEntry[]): string {
  const rows = entries.map(
    (entry) => `  <url><loc>${escape(entry.url)}</loc>${entry.lastModified ? `<lastmod>${escape(entry.lastModified)}</lastmod>` : ""}</url>`,
  );
  return `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${rows.join("\n")}\n</urlset>\n`;
}

/**
 * The rules a creator's domain gives crawlers: everything public may be
 * read, nothing that belongs to one buyer, and where the map is. A store
 * switched off after notices asks not to be read at all.
 */
export function storeRobots(store: Store): string {
  const root = storeRoot(store);
  if (store.suspended) return "User-agent: *\nDisallow: /\n";
  return [
    "User-agent: *",
    "Allow: /",
    "Disallow: /api/",
    "Disallow: /orders",
    "Disallow: /manage",
    "Disallow: /thanks",
    "Disallow: /course",
    "Disallow: /community",
    "",
    `Sitemap: ${root}/sitemap.xml`,
    "",
  ].join("\n");
}
