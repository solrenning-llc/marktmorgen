/**
 * Which spaces of a community a member can see, as one pure decision
 * (399 [SL3], unit 1; added 1 November 2026): the rule lib/community-access.ts
 * applies with the member's real purchases (maySeeSpace, visibleSpaces), and
 * the creator's "View as a member" applies with purchases the creator picks
 * for the preview. One rule, so the preview can never show something a real
 * member would not see, or hide something they would.
 *
 *   - a space kept for nobody in particular is open to every member;
 *   - a space kept for some products opens to a member who holds one of
 *     them, among those that still open the community (a product taken off
 *     the community's own list is ignored, so it shuts nobody out);
 *   - the creator sees every space.
 *
 * The preview's holdings are only the product ids the creator chose: no
 * buyer's identity, address, purchases or token is read or used, and
 * nothing is asked of Stripe for it.
 *
 * Browser-safe: plain data and pure functions.
 */

export type GatedSpace = { id: string; only: string[] };

/** Open to every member, or the products of which a member needs one. */
export type SpaceGate = { open: true } | { open: false; needs: string[] };

export function spaceGate(space: GatedSpace, access: readonly string[]): SpaceGate {
  if (!space.only.length) return { open: true };
  const needs = space.only.filter((p) => access.includes(p));
  return needs.length ? { open: false, needs } : { open: true };
}

/** Whether a member holding these products sees the space. */
export function seesSpace(space: GatedSpace, access: readonly string[], holdings: ReadonlySet<string>): boolean {
  const gate = spaceGate(space, access);
  return gate.open || gate.needs.some((id) => holdings.has(id));
}

/**
 * What "View as a member" shows: the spaces, in the creator's order, that a
 * member holding exactly the products chosen would see. An empty choice is a
 * member who bought none of the products that keep spaces.
 */
export function previewSpaces<S extends GatedSpace>(spaces: readonly S[], access: readonly string[], chosen: readonly string[]): S[] {
  const holdings = new Set(chosen.filter((id) => access.includes(id)));
  return spaces.filter((space) => seesSpace(space, access, holdings));
}

/** The line under "Which spaces a member sees": how many of the spaces; the list itself is drawn under it. */
export function previewLine(chosenCount: number, shownCount: number, total: number): string {
  // Nobody gets into the community without one of its products, so nothing checked is not a member.
  if (chosenCount === 0) return "Check what a member bought to see which spaces they would see.";
  if (shownCount === 0) return "A member with these products sees none of your spaces.";
  if (total === 1) return "A member with these products sees your only space.";
  if (shownCount === total) return `A member with these products sees all ${total} of your spaces:`;
  return `A member with these products sees ${shownCount} of your ${total} spaces:`;
}

/** A space's name in the preview's list, with its place when another space has the same name. */
export function previewName(spaces: readonly { id: string; name: string }[], id: string): string {
  const index = spaces.findIndex((space) => space.id === id);
  if (index < 0) return "";
  const name = spaces[index].name;
  return spaces.filter((space) => space.name === name).length > 1 ? `${name} (space ${index + 1})` : name;
}

/** What the preview does not show, said beside it so it never stands in for more than it is. */
export const PREVIEW_LEAVES_OUT = "This shows which spaces they see, not the posts in them. Events have their own rule and are not shown here. Nothing is changed and nobody is told.";

/** A product that still opens the community but is no longer in the store: still listed, since its buyers still get in. */
export const GONE_PRODUCT = "A product no longer in your store";
