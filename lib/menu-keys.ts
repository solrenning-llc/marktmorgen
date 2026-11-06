/**
 * Arrow keys in the site's menus (524 [NV1], unit 2; added 1 November 2026),
 * after the WAI-ARIA Authoring Practices' disclosure navigation menu: Tab
 * still goes through everything in order, and the arrows are a shortcut on
 * top of it, never the only way.
 *
 *   in the row of menus    Left and Right move between them, Home and End go to the ends,
 *                          Down on a menu's button opens it at its first link, Up at its last
 *   in an open menu        Down and Up move between its links, round from one end to the other,
 *                          Home and End go to its first and last
 *   Escape                 closes the menu and puts the focus back on its button
 *
 * Browser-safe: one pure function.
 */

export type MenuKey = "next" | "previous" | "first" | "last";

/** Where a key moves the focus among `count` items from `index`, or null when it does not move it. */
export function moveFocus(key: string, index: number, count: number, axis: "row" | "list"): number | null {
  if (!Number.isInteger(count) || count <= 0 || !Number.isInteger(index)) return null;
  const forward = axis === "row" ? "ArrowRight" : "ArrowDown";
  const back = axis === "row" ? "ArrowLeft" : "ArrowUp";
  if (key === forward) return (index + 1 + count) % count;
  if (key === back) return (index - 1 + count) % count;
  if (key === "Home") return 0;
  if (key === "End") return count - 1;
  return null;
}
