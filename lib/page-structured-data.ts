/**
 * What a sales page tells search engines beyond the product itself (added
 * 8 October 2026), built only from what the page shows:
 *
 *   - its questions and answers, as an FAQPage, so search engines and the
 *     AI answer engines that read the same markup can quote the creator's
 *     own answers; only questions that have an answer, and not ones kept to
 *     computers, since search engines read the page as a phone shows it;
 *   - where the page sits — the store, then the product — as a
 *     BreadcrumbList, which search results show in place of a bare address.
 *
 * Pure: the page passes in its blocks and addresses.
 */
import type { PageBlock } from "@/lib/sales-page";

/** The most questions put in the markup: what a search result could ever show and more. */
const MAX_FAQ_MARKUP = 30;

export function faqData(blocks: PageBlock[]): object | null {
  const items: { q: string; a: string }[] = [];
  for (const block of blocks) {
    if (block.kind !== "faq" || block.screens === "computer") continue;
    for (const item of block.items) {
      const q = item.q.trim();
      const a = item.a.trim();
      if (q && a && !items.some((seen) => seen.q.toLowerCase() === q.toLowerCase())) items.push({ q, a });
    }
  }
  if (items.length === 0) return null;
  return {
    "@context": "https://schema.org",
    "@type": "FAQPage",
    mainEntity: items.slice(0, MAX_FAQ_MARKUP).map((item) => ({
      "@type": "Question",
      name: item.q,
      acceptedAnswer: { "@type": "Answer", text: item.a },
    })),
  };
}

export function breadcrumbData(store: { name: string; url: string }, product: { title: string; url: string }): object {
  return {
    "@context": "https://schema.org",
    "@type": "BreadcrumbList",
    itemListElement: [
      { "@type": "ListItem", position: 1, name: store.name, item: store.url },
      { "@type": "ListItem", position: 2, name: product.title, item: product.url },
    ],
  };
}

// ------------------------------------------------------------------ courses
//
// 639 [GL7](20). Read on 4 November 2026 (docs/structured-data-2026-11-04.md):
// Google removed the single-course rich result on 9 September 2025 and keeps
// only the course list, which needs at least three courses, each with a name
// and a description and its provider, on a summary page, with each course's
// own page carrying its Course markup. A course name may not carry a price, a
// discount or a call to buy. Only what the page shows is marked up.

/** The fewest courses a course list may mark up (Google's course list rules). */
export const MIN_COURSE_LIST = 3;

/** A course name Google would not take: a price, a discount or a call to buy in it. */
const PROMOTIONAL_NAME = /[$€£¥₹]\s?\d|\d\s?%|\b\d+\s?off\b|\b(?:on sale|discount|buy now|order now|enroll now)\b/i;

export type CourseFacts = { name: string; description: string; url: string };

/** One course, as its own page describes it; null when its name or description cannot be marked up. */
export function courseData(course: CourseFacts, provider: { name: string; url: string }): object | null {
  const name = course.name.trim();
  const description = course.description.trim();
  if (!name || !description || PROMOTIONAL_NAME.test(name)) return null;
  return {
    "@context": "https://schema.org",
    "@type": "Course",
    name,
    description,
    url: course.url,
    provider: { "@type": "Organization", name: provider.name, sameAs: provider.url },
  };
}

/** The store's courses as a list, for the page that lists them; null below MIN_COURSE_LIST markable courses. */
export function courseListData(courses: readonly CourseFacts[], provider: { name: string; url: string }): object | null {
  const urls = [...new Set(courses.filter((c) => courseData(c, provider) !== null).map((c) => c.url))];
  if (urls.length < MIN_COURSE_LIST) return null;
  return {
    "@context": "https://schema.org",
    "@type": "ItemList",
    itemListElement: urls.map((url, i) => ({ "@type": "ListItem", position: i + 1, url })),
  };
}
