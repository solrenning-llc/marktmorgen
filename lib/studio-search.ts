/**
 * What the studio's search answers for one store and one role (766 [STN13],
 * unit 1; the rules in lib/studio-search-rules.ts, the route in
 * app/api/store/studio-search):
 *
 *   - Products, for the roles with "products": the cards of lib/catalog.ts,
 *     read in one exact command (readCardsExact), each opening its own sales
 *     page (/studio/pages, the screen the same permission opens).
 *   - The store's own pages, for the roles with "page": the short list on the
 *     store record (lib/site-page-rules.ts), with no read, each opening its
 *     editor (/studio/site).
 *   - Tools, for everyone: the studio's modules exactly as the gallery "Add to
 *     your store" shows them to this role (lib/studio-modules.ts, galleryFor),
 *     with no read; a card whose plan is not the store's opens the plan only
 *     where the gallery would, and is left out where there is no such link.
 *
 * Every link is the studio's own address for this store (studioPath), so a
 * result never opens another store. Nothing here prints what was searched.
 */
import { type Card, readCardsExact } from "@/lib/catalog";
import type { Store } from "@/lib/store";
import { type Permission, type Role, can } from "@/lib/team-roles";
import { UnknownReplyError } from "@/lib/redis-reply";
import { studioPath } from "@/lib/studio-route";
import { galleryFor } from "@/lib/studio-modules";
import { studioGalleryContext } from "@/lib/studio-actions-offered";
import { type SearchAnswer, type SearchGroup, pickMatches } from "@/lib/studio-search-rules";

/** The answer for `query` (already cleaned, lib/studio-search-rules.ts cleanQuery) on `store`, for `role`. */
export async function studioSearch(store: Store, role: Role, query: string): Promise<SearchAnswer> {
  const may = (permission: Permission) => can(role, permission);
  const groups: SearchGroup[] = [];

  if (may("products")) {
    let cards: Card[] = [];
    let missing = 0;
    let state: SearchGroup["state"] = "ok";
    try {
      ({ cards, missing } = await readCardsExact(store));
      if (missing > 0) state = "partial";
    } catch (error) {
      if (!(error instanceof UnknownReplyError)) throw error;
      state = "unknown";
    }
    const results = pickMatches(cards, query, (card) => ({ title: card.title })).map((card) => ({
      id: card.id,
      title: card.title,
      detail: "Product. Opens its sales page.",
      href: studioPath(store, `product=${card.id}`, "pages"),
    }));
    groups.push({ id: "products", title: "Products", state, missing, results });
  }

  if (may("page")) {
    const results = pickMatches(store.sitePages, query, (page) => ({ title: page.title, extra: page.slug.replace(/-/g, " ") })).map((page) => ({
      id: page.id,
      title: page.title,
      detail: `Your page at /${page.slug}.`,
      href: studioPath(store, `page=${page.id}`, "site"),
    }));
    groups.push({ id: "pages", title: "Your pages", state: "ok", missing: 0, results });
  }

  // The gallery's own context, shared with the box's "Things to do" (lib/studio-actions-offered.ts).
  const ctx = studioGalleryContext(store, role);
  const cards = ctx ? galleryFor(ctx, (segment) => studioPath(store, "", segment)).flatMap((section) => section.cards) : [];
  const reachable = cards.flatMap((card) =>
    card.state === "open"
      ? [{ id: card.id, title: card.title, detail: card.text, href: card.href }]
      : card.href
        ? [{ id: card.id, title: card.title, detail: `Needs the ${card.plan} plan. Opens your plan.`, href: card.href }]
        : [],
  );
  const tools = pickMatches(reachable, query, (tool) => ({ title: tool.title, extra: tool.detail }));
  groups.push({ id: "tools", title: "Tools", state: "ok", missing: 0, results: tools });

  return { groups };
}
