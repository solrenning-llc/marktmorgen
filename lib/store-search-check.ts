/**
 * "Can people find your store?" in the studio (248 [ST1]): what a search
 * engine is given for the store and its first page of products, read only
 * from the store's own record (the same the store page is drawn from), so
 * the studio asks nothing more to show it. Pure, so it can be tested.
 *
 * Each point is what the code does with the creator's words, never a promise
 * about a place in search results:
 *   - the store's description is the line under its name (store.bio); with
 *     none, search engines get a generic sentence (app/[handle]/page.tsx);
 *   - a store with nothing on it is kept out of search results until it has
 *     a product or a link (its robots "index" is off);
 *   - a product's description is its sales page's search description, else
 *     its one-line summary, else the start of its About text; with none, a
 *     generic sentence (app/[handle]/p/[product]/page.tsx). The record has the
 *     summary and whether there is an About text, not the page's own search
 *     description, so a product with neither is listed to check, not called
 *     wrong.
 */
import { KIND, STORE_PAGE_SIZE, visibleCount } from "@/lib/catalog";
import type { Store } from "@/lib/store";
import { canUseDomain } from "@/lib/domains";

export type SearchCheck = {
  /** The line under the store's name, which is its search description. */
  description: boolean;
  /** Whether the store is shown to search engines at all: it has a product or a link, and is not suspended. */
  indexed: boolean;
  /** Whether it is held back because it was suspended after notices about its content (lib/takedown.ts). */
  suspended: boolean;
  /**
   * What AI shopping agents (ChatGPT, Perplexity, Google's AI answers) read
   * the same way (624 [SZ8](42)): the first page's products with no picture,
   * which their product data then has none of.
   */
  agents: { noPicture: string[] };
  /** Visible products on the first page with no one-line summary, by title; and those whose card is not carried. */
  summaries: { missing: string[]; unchecked: number };
  /** Whether the store is on a domain of its own that is live. */
  ownDomain: boolean;
};

export function searchCheck(store: Store): SearchCheck {
  const first = store.catalog.items.filter((item) => (item.kind & KIND.hidden) === 0).slice(0, STORE_PAGE_SIZE);
  const cards = new Map(store.catalog.head.map((listing) => [listing.id, listing]));
  const missing: string[] = [];
  const noPicture: string[] = [];
  let unchecked = 0;
  for (const item of first) {
    const card = cards.get(item.id);
    if (!card) unchecked += 1;
    else if (!card.hidden) {
      if (card.summary.trim().length === 0 && !card.about) missing.push(card.title);
      if (!card.image) noPicture.push(card.title);
    }
  }
  return {
    description: store.bio.trim().length > 0,
    // The store page's own rule (app/[handle]/page.tsx): not suspended, and a visible product or any link.
    indexed: !store.suspended && (visibleCount(store) > 0 || store.links.length > 0),
    suspended: Boolean(store.suspended),
    agents: { noPicture },
    summaries: { missing, unchecked },
    // Named as the store's address only when it is live and the plan allows it, as the store page does.
    ownDomain: Boolean(store.domain?.liveAt) && canUseDomain(store),
  };
}

/** What every store gets for search engines without the creator doing anything, in plain words. */
export const SEARCH_DONE_FOR_YOU: readonly string[] = [
  "A map of your store's pages for search engines, updated as you add products.",
  "Each product page tells search engines its name, its picture when it has one, and its price while it can be bought or picked up (a membership's schedule does not fit that format, so it is named without one).",
  "Your store's questions and answers, and your blog posts, are marked so search engines can read them.",
  "On a domain of your own, search engines are told it is the main address of your store.",
];

/**
 * What AI shopping agents and assistants get from a store without the
 * creator doing anything (624 [SZ8](42)), each what the code does today:
 * the robots rules open the store to every crawler, AI ones included
 * (lib/store-sitemap.ts, storeRobots); each product page carries its name,
 * price, picture and rating as product data (app/[handle]/p/[product]); the
 * creator's own AI assistant reads the store through the MCP server with an
 * API key (app/api/mcp, /developers). Nothing here says where an agent will
 * show the store.
 */
export const AGENTS_GET: readonly string[] = [
  "Your store's public pages are open to AI shopping agents and AI search, the same as to search engines. Buyers' own pages, courses and your community are not.",
  "Each product page tells them its name, its price while it can be bought, its picture when it has one, and its rating when it has enough reviews to show one.",
  "Your own AI assistant, such as Claude or ChatGPT, can read your store's numbers, products, memberships, emails and affiliates with an API key you make in your studio.",
];
