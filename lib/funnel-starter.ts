/**
 * A ready path for the offers after paying (487 [IT4], item 5: no empty
 * screen without a ready example; added 2 November 2026). The common one,
 * from the creator's own products only: an offer and, if the buyer says no
 * thanks, a second one that costs less (lib/funnel.ts calls a "no" leading to
 * the same product for less a downsell; here it is another, cheaper product,
 * since no lower price is made up). Nothing is invented: each offer is a
 * product the creator already sells, at its own price, with the page's own
 * words (its title) until the creator writes theirs. It opens unsaved in the
 * editor (components/funnel-editor.tsx).
 *
 * Only published products that are not bundles are picked: a draft may not be
 * ready, and a bundle may hold what the buyer has just bought, which the
 * funnel does not look inside of (lib/funnel.ts, funnelPosition).
 */

export type StarterProduct = { id: string; title: string; priceCents: number; bundle?: boolean; draft?: boolean };

export type StarterPath = { first: StarterProduct; second: StarterProduct };

/**
 * The path, or null when it cannot be made: the dearest published product
 * that is not a bundle first, then, after no thanks, the cheapest other one
 * that costs strictly less. None when fewer than two qualify or all cost the
 * same.
 */
export function commonPath(offerable: StarterProduct[]): StarterPath | null {
  const fit = offerable.filter((p) => !p.bundle && !p.draft && Number.isSafeInteger(p.priceCents) && p.priceCents > 0);
  if (fit.length < 2) return null;
  const first = fit.reduce((high, p) => (p.priceCents > high.priceCents ? p : high));
  const cheaper = fit.filter((p) => p.id !== first.id && p.priceCents < first.priceCents);
  if (!cheaper.length) return null;
  const second = cheaper.reduce((low, p) => (p.priceCents < low.priceCents ? p : low));
  return { first, second };
}

/** What the button's description says, with the prices: `money` writes cents in the store's currency. */
export function commonPathWords(path: StarterPath, money: (cents: number) => string): string {
  return `Buyers are offered “${path.first.title}” (${money(path.first.priceCents)}). If they say no thanks, they are offered “${path.second.title}” (${money(path.second.priceCents)}), which costs less. You can change either one; nothing is shown to buyers until you save.`;
}
