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

/**
 * A course name Google would not take: a price, a discount or a call to buy
 * in it. Read after readText, so fullwidth digits, hidden characters and
 * doubled spaces cannot slip a price past it. "Free" alone is a plain word.
 */
const PROMOTIONAL_NAME = /\p{Sc}\s?\p{Nd}|\p{Nd}\s?\p{Sc}|\p{Nd}\s?(?:%|percent\b)|\b\p{Nd}+\s?off\b|\b(?:on sale|discount(?:ed)?|buy now|order now|enroll? now|half price|limited time|save \p{Nd}+|only \p{Nd}+|\p{Nd}+ (?:dollars?|euros?|reais|yen)|enroll today|today only)\b/iu;
/** A price in a currency's code, written in capitals as codes are ("30 USD", "EUR 30"). */
const CURRENCY_CODE_PRICE = /\b(?:USD|EUR|GBP|JPY|CAD|AUD|NZD|CHF|BRL|MXN|INR|CNY|SEK|NOK|DKK|ZAR|KRW|PLN|CZK|HUF|SGD|HKD)\s?\p{Nd}|\p{Nd}\s?(?:USD|EUR|GBP|JPY|CAD|AUD|NZD|CHF|BRL|MXN|INR|CNY|SEK|NOK|DKK|ZAR|KRW|PLN|CZK|HUF|SGD|HKD)\b/u;
/** The longest description sent: Google shows 60 characters of it. */
const MAX_COURSE_DESCRIPTION = 5_000;

export type CourseFacts = { name: string; description: string; url: string };

/** Text as the page shows it: one form (NFC), spaces single, as HTML collapses them. Nothing visible is changed. */
function shownText(text: string): string {
  return text.normalize("NFC").replace(/\s+/gu, " ").trim();
}

/** Text as the filters read it: compatibility forms folded and hidden format characters gone, so nothing hides a price. */
function readText(text: string): string {
  return text.normalize("NFKC").replace(/\p{Cf}/gu, "").replace(/\s+/gu, " ").trim();
}

/**
 * A course's own page, on the store's own site, as one address: https, the
 * store's host, a path under the store's own path (on marktmorgen.com,
 * "/@handle/…", never another store's or the site's own pages) and not the
 * store's root, no credentials, no query and no fragment, no trailing slash.
 * Null otherwise.
 */
function courseUrl(url: string, site: string): string | null {
  try {
    const at = new URL(url);
    const home = new URL(site);
    if (at.protocol !== "https:" || at.host !== home.host || at.username || at.password) return null;
    const path = at.pathname.replace(/\/+$/, "");
    const base = home.pathname.replace(/\/+$/, "");
    if (!path || path === base || !path.startsWith(`${base}/`)) return null;
    return `${at.origin}${path}`;
  } catch {
    return null;
  }
}

/** One course, as its own page describes it; null when its name, description or address cannot be marked up. */
export function courseData(course: CourseFacts, provider: { name: string; url: string }): object | null {
  const name = shownText(course.name);
  const description = Array.from(shownText(course.description)).slice(0, MAX_COURSE_DESCRIPTION).join("");
  const url = courseUrl(course.url, provider.url);
  const read = readText(course.name);
  if (!readText(name) || !readText(description) || !url || PROMOTIONAL_NAME.test(read) || CURRENCY_CODE_PRICE.test(read)) return null;
  const by = shownText(provider.name);
  return {
    "@context": "https://schema.org",
    "@type": "Course",
    name,
    description,
    url,
    // Recommended, not required: left out rather than sent empty.
    ...(by ? { provider: { "@type": "Organization", name: by, sameAs: provider.url } } : {}),
  };
}

/**
 * The store's courses as a list, for the page that lists them: every course
 * the page lists, or none, so the list never says less than the page shows;
 * null below MIN_COURSE_LIST courses, or when any of them cannot be marked
 * up. The same course under two spellings of its address counts once.
 */
export function courseListData(courses: readonly CourseFacts[], provider: { name: string; url: string }): object | null {
  const marked = courses.map((c) => courseData(c, provider) as { url: string } | null);
  if (marked.some((c) => c === null)) return null;
  const urls = [...new Set(marked.map((c) => c!.url))];
  if (urls.length < MIN_COURSE_LIST) return null;
  return {
    "@context": "https://schema.org",
    "@type": "ItemList",
    itemListElement: urls.map((url, i) => ({ "@type": "ListItem", position: i + 1, url })),
  };
}
