/**
 * The products a bundle can be made of, found by name, a page at a time.
 *
 * Read by the picker in /studio/bundles (app/api/store/bundle, GET) and by the
 * MCP tool list_bundle_choices (631 [AA1] (a)), so an agent preparing a bundle
 * is offered exactly what the creator's own picker offers, with the same
 * reason when a product cannot go in. The picker's reading moved here
 * unchanged from the route.
 */
import { BUMP_CHOICES, cachedCards, idsOfKind, productIds, readCards, readListings, readListingsExactMeasured } from "@/lib/catalog";
import { whyNotInBundle } from "@/lib/bundle-rules";
import { UnknownReplyError } from "@/lib/redis-reply";
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

/** The picker's page: what can go in first, then the rest, each in the creator's own order. */
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
  const cards = await readCards(store);
  const { ruledOut, withOptions } = byKind(store);
  const narrowed = [...cards.values()].filter((card) => card.id !== owner && !ruledOut.has(card.id) && !withOptions.has(card.id));
  const named = query ? narrowed.filter((card) => card.title.toLowerCase().includes(query)) : narrowed;
  const matches = await readListings(store, named.slice(0, BUMP_CHOICES).map((card) => card.id));
  const sorted = [...matches.filter((p) => !whyNotInBundle(p)), ...matches.filter((p) => whyNotInBundle(p))];
  const from = (page - 1) * PICKER_PAGE;
  const products = sorted.slice(from, from + PICKER_PAGE).map(choiceOf);
  return { products, matches: matches.length, more: from + PICKER_PAGE < sorted.length, page };
}

/** What the store's own index rules out of any bundle before a read: memberships, calls and products with price options. */
function byKind(store: Store) {
  const ruledOut = new Set([...idsOfKind(store, "recurring"), ...idsOfKind(store, "call")]);
  const withOptions = new Set(store.catalog.items.filter((item) => item.options.length > 0).map((item) => item.id));
  return { ruledOut, withOptions };
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

/** Names looked through for a search in one call (one HMGET of the cached cards), and the products shown then. */
export const SEARCH_STRETCH = 100;
export const SEARCH_PAGE = PICKER_PAGE - 1;

/** What one page read, to settle what it was paid for at (lib/api-read-rules.ts, bundleChoicesWork). */
export type ChoicesRead = { cards: number; listings: number; bytes: number };

/**
 * One page for the MCP tool list_bundle_choices (Codex A3 on #1933, twice):
 * the ids are chosen first, from the store's own index that its record
 * already holds (nothing read), and only then are those read: without a
 * search, the PICKER_PAGE listings from the cursor; with one, the cached
 * names of the next SEARCH_STRETCH ids in one HMGET, then the listings of at
 * most SEARCH_PAGE that match. The whole catalog is never read or healed in
 * one call: each call stays inside what it is paid for before it reads. A
 * product whose name is not cached yet cannot be searched, and is counted in
 * `unsearched`, never read for free. `next` is where the next page starts,
 * null at the end; `matches` is how many may go in by their kind, without a
 * search, and null with one (each stretch is searched as it comes).
 *
 * Read on Redis's exact answers only (CX-123 rule 24; Codex G2 and A3 on
 * #1933): a page or a stretch of names that could not be read whole is
 * `unknown`, never a page with products left out. `read` is what it read.
 */
export async function bundleChoicesPage(
  store: Store,
  input: { owner: string; query: string; after: number },
): Promise<
  | { known: true; products: BundleChoice[]; matches: number | null; next: number | null; unsearched: number; read: ChoicesRead }
  | { known: false; read: ChoicesRead }
> {
  const { ruledOut, withOptions } = byKind(store);
  const ids = productIds(store).filter((id) => id !== input.owner && !ruledOut.has(id) && !withOptions.has(id));
  const from = Math.min(Math.max(0, input.after), ids.length);
  const read: ChoicesRead = { cards: 0, listings: 0, bytes: 0 };
  const listingsOf = async (asked: string[]) => {
    read.listings += asked.length;
    try {
      const measured = await readListingsExactMeasured(store, asked);
      read.bytes += measured.bytes;
      // Every id asked is one the store's index lists: one Redis confirms is not there is no product, so it is not shown.
      return measured.listings;
    } catch (error) {
      if (error instanceof UnknownReplyError) return null;
      throw error;
    }
  };
  if (!input.query) {
    const listed = await listingsOf(ids.slice(from, from + PICKER_PAGE));
    if (!listed) return { known: false, read };
    return { known: true, products: listed.map(choiceOf), matches: ids.length, next: from + PICKER_PAGE < ids.length ? from + PICKER_PAGE : null, unsearched: 0, read };
  }
  const stretch = ids.slice(from, from + SEARCH_STRETCH);
  let cards: Map<string, { title: string } | null>;
  read.cards = stretch.length;
  try {
    const found = await cachedCards(store, stretch);
    read.bytes += found.bytes;
    cards = found.cards;
  } catch (error) {
    if (error instanceof UnknownReplyError) return { known: false, read };
    throw error;
  }
  const found: string[] = [];
  let unsearched = 0;
  let at = from;
  for (const id of stretch) {
    if (found.length >= SEARCH_PAGE) break;
    at += 1;
    const card = cards.get(id);
    if (!card) unsearched += 1;
    else if (card.title.toLowerCase().includes(input.query)) found.push(id);
  }
  const listed = await listingsOf(found);
  if (!listed) return { known: false, read };
  return { known: true, products: listed.map(choiceOf), matches: null, next: at < ids.length ? at : null, unsearched, read };
}
