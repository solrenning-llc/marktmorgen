/**
 * "What do you want to do?" inside the studio's one search box (486 [IT3],
 * unit 2; the box is 766 [STN13], components/studio-search.tsx): the actions
 * of lib/studio-actions.ts are the box's first group, "Things to do".
 *
 * The server works out, once per page, which actions this person may open on
 * this store and where each goes (offeredFor in lib/studio-actions-gallery.ts,
 * from the same GalleryContext as the gallery "Add to your store", which
 * lib/studio-actions-offered.ts builds).
 * The box then finds actions in that list as the person types, in the
 * browser: no request, no read and no cost of their own, and still there when
 * the search route says no. An action the server did not offer, or an id this
 * list does not know, is never shown.
 *
 * Pure and browser-safe: nothing here reads Redis, settings or the store,
 * and nothing of the gallery is carried to the browser.
 */
import { MAX_RESULTS, STUDIO_ACTIONS, score, termsOf } from "@/lib/studio-actions";
import { type SearchAnswer, type SearchGroup, type SearchResult, PER_GROUP, cleanQuery, hasAt } from "@/lib/studio-search-rules";

/** The group's name, as the box shows it above its actions and a screen reader reads it. */
export const ACTIONS_TITLE = "Things to do";

/**
 * One action this person may open on this store: where it goes, the plan it
 * needs when the store's plan does not include it, and the gallery module it
 * opens (null for a section of the studio's home), so the same screen is not
 * shown again as a tool.
 */
export type OfferedAction = { id: string; href: string; plan: string | null; module: string | null };

const DETAIL_SCREEN = "Opens the screen that does it.";
const DETAIL_HOME = "Opens that part of your studio's home.";

type Found = SearchResult & { module: string | null };

function found(query: string, offered: readonly OfferedAction[]): Found[] {
  const typed = termsOf(query);
  if (typed.length === 0 || !Array.isArray(offered)) return [];
  const where = new Map<string, OfferedAction>();
  for (const entry of offered) if (entry && typeof entry.id === "string" && !where.has(entry.id)) where.set(entry.id, entry);
  return STUDIO_ACTIONS.flatMap((action, index) => {
    const entry = where.get(action.id);
    const fits = entry ? score(typed, action) : 0;
    return entry && fits > 0 ? [{ action, entry, fits, index }] : [];
  })
    .sort((a, b) => b.fits - a.fits || a.index - b.index)
    .slice(0, Math.min(MAX_RESULTS, PER_GROUP))
    .map(({ action, entry }) => ({
      id: action.id,
      title: action.title,
      detail: entry.plan ? `Needs the ${entry.plan} plan. Opens your plan.` : action.segment ? DETAIL_SCREEN : DETAIL_HOME,
      href: entry.href,
      module: entry.module,
    }));
}

/** The actions that fit the words, best first, at most one group's worth; only ones the server offered. */
export function matchActions(query: string, offered: readonly OfferedAction[]): SearchResult[] {
  return found(query, offered).map(({ id, title, detail, href }) => ({ id, title, detail, href }));
}

/**
 * The box's answer with the actions as its first group: the route's answer
 * (null while none has come, or when the route said no) after them, with a
 * tool left out where an action shown opens the same module. Words the box
 * would not search, and an address, find no action.
 */
export function withActions(query: string, offered: readonly OfferedAction[], answer: SearchAnswer | null): SearchAnswer {
  const q = cleanQuery(query);
  const actions = q === null || hasAt(q) ? [] : found(q, offered);
  const shown = new Set(actions.flatMap((action) => (action.module ? [action.module] : [])));
  const group: SearchGroup = {
    id: "actions",
    title: ACTIONS_TITLE,
    state: "ok",
    missing: 0,
    results: actions.map(({ id, title, detail, href }) => ({ id, title, detail, href })),
  };
  const rest = (answer?.groups ?? []).map((other) =>
    other.id === "tools" && shown.size > 0 ? { ...other, results: other.results.filter((tool) => !shown.has(tool.id)) } : other,
  );
  return { groups: [group, ...rest] };
}
