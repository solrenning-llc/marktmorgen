/**
 * The title and description a product's public page gives search engines and
 * shared links (248 [ST1]), in one place: the page's metadata
 * (app/[handle]/p/[product]/page.tsx, generateMetadata) and the studio's
 * "What search engines are given" (components/search-snippet-preview.tsx)
 * both read it, so what the creator is shown is what the page sends.
 *
 * Each falls back in the page's order, and says which one it took:
 *   - title: the page's own search title, else "<product> — <store>";
 *   - description: the page's own search description, else the product's
 *     one-line summary, else the start of its About text, else a general
 *     sentence in the store's language.
 *
 * Pure: the About excerpt and the general sentence are given, already made
 * (lib/product-about.ts aboutExcerpt, lib/buyer-words productDescription), so
 * the studio's client code needs neither the About store nor every language.
 */

export type TitleFrom = "yours" | "default";
/** A product page: summary, About, general. A store page (sitePageSnippet): subheadline, store description, sentence. */
export type DescriptionFrom = "yours" | "summary" | "about" | "general" | "subheadline" | "bio" | "sentence";

export type SearchSnippet = {
  title: string;
  description: string;
  titleFrom: TitleFrom;
  descriptionFrom: DescriptionFrom;
  /**
   * Whether the page is kept from visitors (hidden, or not yet at its time to show): then the product's plain page
   * is what is shown and what search engines get (lib/sales-page.ts, livePage), so the page's own search words wait.
   */
  waiting: boolean;
  /** A product's page, or one of the store's own pages, whose rule and words differ. */
  kind: "product" | "site";
};

export type SnippetInput = {
  /** The page's own search title and description, as saved (or as being typed in the studio). */
  seoTitle: string;
  seoDescription: string;
  productTitle: string;
  /** The product's one-line summary. */
  summary: string;
  storeName: string;
  /** The start of the product's About text, as aboutExcerpt makes it; "" with none. */
  aboutLine: string;
  /** The general sentence in the store's language, for a product with none of the above. */
  general: string;
  /** Whether visitors are shown the page (lib/sales-page.ts, pageShown); false while it is hidden. Shown if left out. */
  shown?: boolean;
};

/** What the product page gives search engines, and where each part comes from. */
export function productSearchSnippet(input: SnippetInput): SearchSnippet {
  // A page kept from visitors is read as none by the public page, its search words included.
  const waiting = input.shown === false;
  const seoTitle = waiting ? "" : flat(input.seoTitle);
  const seoDescription = waiting ? "" : flat(input.seoDescription);
  const titleFrom: TitleFrom = seoTitle ? "yours" : "default";
  const title = seoTitle || `${input.productTitle} — ${input.storeName}`;
  const kind = "product";
  if (seoDescription) return { title, titleFrom, description: seoDescription, descriptionFrom: "yours", waiting, kind };
  if (input.summary) return { title, titleFrom, description: input.summary, descriptionFrom: "summary", waiting, kind };
  if (input.aboutLine) return { title, titleFrom, description: input.aboutLine, descriptionFrom: "about", waiting, kind };
  return { title, titleFrom, description: input.general, descriptionFrom: "general", waiting, kind };
}

/**
 * A field as the page keeps it once saved: lib/sales-page.ts parses each of
 * these lines to one line of single spaces, trimmed, so what is typed is
 * compared as it will be kept, and a field of spaces is empty.
 */
function flat(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

/** The most of a store page's description its metadata gives (app/[handle]/[slug]/page.tsx). */
export const SITE_DESCRIPTION_MAX = 300;

export type SiteSnippetInput = {
  seoTitle: string;
  seoDescription: string;
  /** The page's title, as its menu names it. */
  pageTitle: string;
  /** The subheadline of the page's first block when that block is a hero; "" otherwise. */
  subheadline: string;
  /** The store's description, the line under its name. */
  storeBio: string;
  storeName: string;
  /** The sentence in the store's language for a page with none of the above (lib/buyer-words, pageDescription). */
  general: string;
  /** Whether the page is on the store: it has a block and is not kept back. */
  shown: boolean;
};

/**
 * What one of the store's own pages (lib/site-page-rules.ts) gives search
 * engines, in its page's order (app/[handle]/[slug]/page.tsx): own title, else
 * "<page> — <store>"; own description, else the first hero's subheadline, else
 * the store's description, else a sentence naming the page and the store in the
 * store's language ("<page>, from <store>." in English); at most 300
 * characters. A page with no block, or kept back, is not on the store at all:
 * `waiting`, with what it will give once it shows.
 */
export function sitePageSnippet(input: SiteSnippetInput): SearchSnippet {
  const seoTitle = flat(input.seoTitle);
  const seoDescription = flat(input.seoDescription);
  const subheadline = flat(input.subheadline);
  const titleFrom: TitleFrom = seoTitle ? "yours" : "default";
  const title = seoTitle || `${input.pageTitle} — ${input.storeName}`;
  const [description, descriptionFrom]: [string, DescriptionFrom] = seoDescription
    ? [seoDescription, "yours"]
    : subheadline
      ? [subheadline, "subheadline"]
      : input.storeBio
        ? [input.storeBio, "bio"]
        : [input.general, "sentence"];
  return { title, titleFrom, description: description.slice(0, SITE_DESCRIPTION_MAX), descriptionFrom, waiting: !input.shown, kind: "site" };
}

/** Said above the parts while the page is kept from visitors. */
export const WAITING_WORDS: Record<SearchSnippet["kind"], string> = {
  product: "This page is hidden, so visitors and search engines get the product's plain page. The title and description above are given once the page shows.",
  site: "This page is not on your store yet, because it is hidden or has no blocks, so search engines get nothing from it. Once it shows, it gives them this title and description.",
};

/** Where a part came from, in plain words for the studio. */
export const TITLE_FROM_WORDS: Record<SearchSnippet["kind"], Record<TitleFrom, string>> = {
  product: { yours: "From the title above.", default: "From the product's name and your store's name." },
  site: { yours: "From the title above.", default: "From the page's title and your store's name." },
};

export const DESCRIPTION_FROM_WORDS: Record<DescriptionFrom, string> = {
  yours: "From the description above.",
  summary: "From the product's one-line summary.",
  about: "From the start of the product's About text.",
  general: "A general sentence, because the product has no summary or About text. Write a description above to use your own words.",
  subheadline: "From the subheadline of the page's first block.",
  bio: "From your store's description, the line under its name.",
  sentence: "A general sentence, because the page's first block has no subheadline and your store has no description. Write a description above to use your own words.",
};
