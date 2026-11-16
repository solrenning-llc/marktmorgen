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
export type DescriptionFrom = "yours" | "summary" | "about" | "general";

export type SearchSnippet = {
  title: string;
  description: string;
  titleFrom: TitleFrom;
  descriptionFrom: DescriptionFrom;
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
};

/** What the product page gives search engines, and where each part comes from. */
export function productSearchSnippet(input: SnippetInput): SearchSnippet {
  // The studio sends both fields trimmed (components/page-editor.tsx) and the
  // page keeps what was sent, so a field of spaces counts as empty here too.
  const seoTitle = input.seoTitle.trim();
  const seoDescription = input.seoDescription.trim();
  const titleFrom: TitleFrom = seoTitle ? "yours" : "default";
  const title = seoTitle || `${input.productTitle} — ${input.storeName}`;
  if (seoDescription) return { title, titleFrom, description: seoDescription, descriptionFrom: "yours" };
  if (input.summary) return { title, titleFrom, description: input.summary, descriptionFrom: "summary" };
  if (input.aboutLine) return { title, titleFrom, description: input.aboutLine, descriptionFrom: "about" };
  return { title, titleFrom, description: input.general, descriptionFrom: "general" };
}

/** Where a part came from, in plain words for the studio. */
export const TITLE_FROM_WORDS: Record<TitleFrom, string> = {
  yours: "From the title above.",
  default: "The title above is empty, so the page uses the product's name and your store's name.",
};

export const DESCRIPTION_FROM_WORDS: Record<DescriptionFrom, string> = {
  yours: "From the description above.",
  summary: "The description above is empty, so the page uses the product's one-line summary.",
  about: "The description above is empty and the product has no one-line summary, so the page uses the start of its About text.",
  general: "This product has no description, summary or About text, so the page uses a general sentence. Write a description above to use your own words.",
};
