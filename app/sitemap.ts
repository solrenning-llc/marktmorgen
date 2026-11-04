import type { MetadataRoute } from "next";
import { BLOG_POSTS } from "@/lib/blog";
import { PAGES } from "@/lib/site-pages";
import { SITE_URL } from "@/lib/site-url";
import { HOUSE_HANDLE } from "@/lib/house-store";

/**
 * Every page on this site that is worth finding, listed for search engines.
 *
 * It is written from the same arrays the pages themselves are built from, so a
 * new comparison page or a new article is in here the moment it exists. A
 * hand-kept list would fall behind on the first busy day and nobody would
 * notice, because nothing on the site looks broken when a page is missing from
 * the sitemap — it just never gets read.
 *
 * Deliberately absent: /studio and /signin, which are a creator's own account
 * and carry noindex already; and creator store pages, which are listed by
 * their own owners rather than by us. The demo store is the one store that is
 * ours (lib/house-store.ts), so it is listed, at the address stores have.
 */
export default function sitemap(): MetadataRoute.Sitemap {
  const url = (path: string) => `${SITE_URL}${path}`;

  // The one date we actually know is each article's. Every other page goes
  // without one: stamping "today" on every request told Google that all 68
  // pages had changed every day, which teaches it to ignore the field and
  // left 15 pages "discovered, not indexed" (Search Console, Oct 2026).
  // Google reads lastmod only when it is verifiably accurate; none is better
  // than a false one.

  const fixed: { path: string; priority: number }[] = [
    { path: "/", priority: 1 },
    { path: "/pricing", priority: 0.8 },
    { path: "/blog", priority: 0.8 },
    { path: "/platform", priority: 0.8 },
    { path: "/grow-sales", priority: 0.8 },
    { path: "/mission", priority: 0.6 },
    { path: "/help", priority: 0.6 },
    { path: "/developers", priority: 0.4 },
    { path: "/developers/checkout-script", priority: 0.4 },
    { path: "/creators", priority: 0.5 },
    { path: `/@${HOUSE_HANDLE}`, priority: 0.5 },
    { path: "/terms", priority: 0.3 },
    { path: "/privacy", priority: 0.3 },
    { path: "/accessibility", priority: 0.3 },
    { path: "/refunds", priority: 0.3 },
    { path: "/copyright", priority: 0.2 },
  ];

  return [
    ...fixed.map((page) => ({
      url: url(page.path),
      changeFrequency: "weekly" as const,
      priority: page.priority,
    })),
    ...PAGES.map((page) => ({
      url: url(`/${page.section}/${page.slug}`),
      changeFrequency: "monthly" as const,
      priority: 0.7,
    })),
    ...BLOG_POSTS.map((post) => ({
      url: url(`/blog/${post.slug}`),
      lastModified: new Date(`${post.date}T12:00:00Z`),
      changeFrequency: "monthly" as const,
      priority: 0.7,
    })),
  ];
}
