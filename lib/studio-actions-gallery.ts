/**
 * The studio's actions (lib/studio-actions.ts, 486 [IT3]) against the
 * gallery "Add to your store" (lib/studio-modules.ts): which actions a person
 * may open on a store, where each goes, and unit 1's search over them. Kept
 * apart from the list and its matching so the search box can find actions in
 * the browser without carrying the gallery (486 [IT3], unit 2).
 */
import { MAX_RECENT, MAX_RESULTS, STUDIO_ACTIONS, type StudioAction, readRecent, score, termsOf } from "@/lib/studio-actions";
import { STUDIO_MODULES, cardFor, shows, type GalleryContext } from "@/lib/studio-modules";
import type { OfferedAction } from "@/lib/studio-search-actions";

/** A result: what it does, where it goes, and the plan it needs when the store's plan does not include it. */
export type ActionResult = { id: string; title: string; href: string; plan: string | null };

/** Whether an action is shown to this person on this store: its card's role and conditions in the gallery, or the action's permission. */
export function available(action: StudioAction, ctx: GalleryContext): boolean {
  const screen = action.segment ? STUDIO_MODULES.find((entry) => entry.segment === action.segment) : undefined;
  if (screen) return shows(screen, ctx);
  return action.permission === "member" || ctx.may(action.permission);
}

/**
 * Where an action goes: its screen, or its section of the studio home; for a
 * module the store's plan does not include, the way to the plan, as the
 * gallery says it (cardFor); null when there is no way from here.
 */
export function resultFor(action: StudioAction, ctx: GalleryContext, href: (segment: string) => string): ActionResult | null {
  const screen = action.segment ? STUDIO_MODULES.find((entry) => entry.segment === action.segment) : undefined;
  if (screen) {
    const card = cardFor(screen, ctx, href);
    if (card.state === "plan") return card.href ? { id: action.id, title: action.title, href: card.href, plan: card.plan } : null;
    return { id: action.id, title: action.title, href: card.href, plan: null };
  }
  const base = href(action.segment);
  return { id: action.id, title: action.title, href: action.anchor ? `${base}#${action.anchor}` : base, plan: null };
}

/**
 * The results of one search, best first: how well the words fit, then the
 * actions this person opened most recently, then the order above. With no
 * words to search, the recently opened actions, most recent first.
 */
export function searchActions(query: string, ctx: GalleryContext, href: (segment: string) => string, recent: readonly string[] = []): ActionResult[] {
  const typed = termsOf(query);
  const order = readRecent(recent);
  const rank = (id: string) => {
    const at = order.indexOf(id);
    return at === -1 ? MAX_RECENT : at;
  };
  const candidates = typed.length === 0
    ? STUDIO_ACTIONS.filter((action) => order.includes(action.id)).map((action) => ({ action, fits: 0 }))
    : STUDIO_ACTIONS.map((action) => ({ action, fits: score(typed, action) })).filter((entry) => entry.fits > 0);
  const results: ActionResult[] = [];
  for (const { action } of candidates
    .map((entry, index) => ({ ...entry, index }))
    .sort((a, b) => b.fits - a.fits || rank(a.action.id) - rank(b.action.id) || a.index - b.index)) {
    if (!available(action, ctx)) continue;
    const result = resultFor(action, ctx, href);
    if (result) results.push(result);
    if (results.length === MAX_RESULTS) break;
  }
  return results;
}

/** Every action this person may open, in the list's own order, for the search box (lib/studio-search-actions.ts). */
export function offeredFor(ctx: GalleryContext, href: (segment: string) => string): OfferedAction[] {
  const offered: OfferedAction[] = [];
  for (const action of STUDIO_ACTIONS) {
    if (!available(action, ctx)) continue;
    const result = resultFor(action, ctx, href);
    if (!result) continue;
    const screen = action.segment ? (STUDIO_MODULES.find((entry) => entry.segment === action.segment)?.id ?? null) : null;
    offered.push({ id: action.id, href: result.href, plan: result.plan, module: screen });
  }
  return offered;
}
