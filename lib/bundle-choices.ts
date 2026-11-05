/**
 * The products a bundle can be made of, found by name, a page at a time.
 *
 * Read by the picker in /studio/bundles (app/api/store/bundle, GET) and by the
 * MCP tool list_bundle_choices (631 [AA1]), so an agent preparing a bundle is
 * offered exactly what the creator's own picker offers, with the same reason
 * when a product cannot go in. Moved here unchanged from the route.
 */
import { BUMP_CHOICES, idsOfKind, readCards, readListings } from "@/lib/catalog";
import { whyNotInBundle } from "@/lib/bundle-rules";
import type { Store } from "@/lib/store";

/** Products one page of the picker shows. */
export const PICKER_PAGE = 20;

export type BundleChoice = {
  id: string;
  title: string;
  priceCents: number;
  /** "Course, 4 lessons", "Download", "Link", or "" when it hands over nothing yet. */
  what: string;
  hidden: boolean;
  /** Why it cannot go in a bundle, in the studio's words; null when it can. */
  why: string | null;
};

/** A search typed by the creator or an agent: spaces folded, short, lower case. */
export function choiceQuery(raw: unknown): string {
  return (typeof raw === "string" ? raw : "").replace(/\s+/g, " ").trim().slice(0, 80).toLowerCase();
}

/** A page number from 1 to 200; anything else is the first page. */
export function choicePage(raw: unknown): number {
  return Math.max(1, Math.min(200, Number(raw) || 1));
}

export async function bundleChoices(
  store: Store,
  input: { owner: string; query: string; page: number },
): Promise<{ products: BundleChoice[]; matches: number; more: boolean; page: number }> {
  /*
   * Whether a product can go in a bundle needs things the card does not
   * carry, but the store's own index rules most of a catalogue out before a
   * single read: a membership, a call and a product with price options can
   * never go in one. Names come from the card hash, so the search is one
   * command, and only what survives both is read — at most BUMP_CHOICES,
   * which is far more than a picker showing PICKER_PAGE at a time can reach.
   * This used to read every product in the store on every keystroke.
   */
  const { owner, query, page } = input;
  const named = await candidatesOf(store, owner, query);
  const matches = await readListings(store, named.slice(0, BUMP_CHOICES).map((card) => card.id));
  // What can go in first, then the rest, each in the creator's own order.
  const sorted = [...matches.filter((p) => !whyNotInBundle(p)), ...matches.filter((p) => whyNotInBundle(p))];
  const from = (page - 1) * PICKER_PAGE;
  const products = sorted.slice(from, from + PICKER_PAGE).map(choiceOf);
  return { products, matches: matches.length, more: from + PICKER_PAGE < sorted.length, page };
}

/**
 * The products that may go in a bundle by what the store's own index says,
 * named like `query`, in the creator's order, not counting `owner`: from the
 * card hash, one command, before any listing is read.
 */
async function candidatesOf(store: Store, owner: string, query: string) {
  const cards = await readCards(store);
  const ruledOut = new Set([...idsOfKind(store, "recurring"), ...idsOfKind(store, "call")]);
  const withOptions = new Set(store.catalog.items.filter((item) => item.options.length > 0).map((item) => item.id));
  const narrowed = [...cards.values()].filter((card) => card.id !== owner && !ruledOut.has(card.id) && !withOptions.has(card.id));
  return query ? narrowed.filter((card) => card.title.toLowerCase().includes(query)) : narrowed;
}

function choiceOf(p: Awaited<ReturnType<typeof readListings>>[number]): BundleChoice {
  return {
    id: p.id,
    title: p.title,
    priceCents: p.priceCents,
    what: p.course ? `Course, ${p.course.lessons} ${p.course.lessons === 1 ? "lesson" : "lessons"}` : p.file ? "Download" : p.link ? "Link" : "",
    hidden: p.hidden,
    why: whyNotInBundle(p),
  };
}

/** A cursor from the MCP tool: where the next page starts, 0 for the first; anything else is the first page. */
export function choiceCursor(raw: unknown): number {
  const n = typeof raw === "string" && /^\d{1,6}$/.test(raw) ? Number(raw) : typeof raw === "number" && Number.isSafeInteger(raw) ? raw : 0;
  return Math.max(0, n);
}

/**
 * One page for the MCP tool list_bundle_choices (Codex A3 on #1933): at most
 * PICKER_PAGE listings read, what one API request pays for, in the creator's
 * own order from `after`, each with why it cannot go in a bundle; and where
 * the next page starts, or null at the end. Nothing past the page is read, so
 * an agent sees the whole catalog a page at a time, each page inside what
 * it paid. `matches` counts the products the store's index leaves in, each
 * checked when its page is read.
 */
export async function bundleChoicesPage(store: Store, input: { owner: string; query: string; after: number }): Promise<{ products: BundleChoice[]; matches: number; next: number | null }> {
  const named = await candidatesOf(store, input.owner, input.query);
  const from = Math.min(Math.max(0, input.after), named.length);
  const listed = await readListings(store, named.slice(from, from + PICKER_PAGE).map((card) => card.id));
  return { products: listed.map(choiceOf), matches: named.length, next: from + PICKER_PAGE < named.length ? from + PICKER_PAGE : null };
}
