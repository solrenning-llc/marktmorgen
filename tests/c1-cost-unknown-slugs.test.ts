/**
 * An address under /blog, /platform, /for or /proof that names no page is a
 * plain 404, never a page rendered and stored for that address.
 *
 * Each of these sections lists every page it has in generateStaticParams, so
 * every real page is built ahead of time. With Next's default dynamicParams
 * (true), an address outside that list is rendered when it is first asked for
 * and kept in the ISR cache under its own path, for good (revalidate false):
 * the page's notFound() is stored as an APP_PAGE entry with status 404
 * (next/dist/build/templates/app-page-runtime.js), and the article's share
 * picture, which answers an unknown slug with a full 1200×630 PNG on purpose,
 * is drawn and stored the same way (templates/app-route.js: isIsr, cacheKey =
 * the path). So /blog/a1, /blog/a2 … each cost a function run and an ISR write
 * that nothing bounds; a crawler or a loop mints them without end
 * (C1 cost audit, 12 November 2026).
 *
 * With dynamicParams = false the route's fallback is false: an unknown address
 * answers 404 without running the page or the picture, and writes nothing.
 * The real pages are unchanged, since each section's list is the same list
 * its page reads from (checked below).
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { BLOG_POSTS, postBySlug } from "@/lib/blog";
import { findPage, slugsFor } from "@/lib/site-pages";
import { done, is, part } from "./check";

const ROUTES = [
  "app/blog/[slug]/page.tsx",
  "app/blog/[slug]/opengraph-image.tsx",
  "app/platform/[slug]/page.tsx",
  "app/for/[slug]/page.tsx",
  "app/proof/[slug]/page.tsx",
];

const source = (file: string) => readFileSync(join(process.cwd(), file), "utf8");

function main(): void {
  part("Every route whose pages are all listed ahead of time answers an unknown address with a plain 404");
  for (const file of ROUTES) {
    const text = source(file);
    is(`${file} lists its pages ahead of time`, /export function generateStaticParams\(/.test(text), true);
    is(`${file} renders and stores nothing for an address outside that list`, /export const dynamicParams = false;/.test(text), true);
  }

  part("No real page is lost: each list holds every page its route serves");
  is("every article is listed, and each listed slug is an article", BLOG_POSTS.every((post) => postBySlug(post.slug) === post), true);
  for (const section of ["platform", "for", "proof"] as const) {
    const listed = slugsFor(section).map((p) => p.slug);
    is(`/${section}: at least one page listed`, listed.length > 0, true);
    is(`/${section}: every listed slug is a page`, listed.every((slug) => findPage(section, slug) !== undefined), true);
  }
  done();
}

main();
