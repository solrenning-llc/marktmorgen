/**
 * Arrow keys in the site's menus (524 [NV1], unit 2; added 1 November 2026),
 * after the WAI-ARIA Authoring Practices' disclosure navigation menu: Tab
 * goes through everything in order, and the arrows are a shortcut on top of
 * it, never the only way.
 *
 *   Tab                    on an open menu's button goes into its panel (#3663); the panel is drawn after the
 *                          whole row, so its two edges are routed: Tab from its last link goes on to what
 *                          follows the button (the panel closes), Shift+Tab from its first link goes back
 *                          to the button (WCAG 2.4.3)
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

/** Whether Tab should enter an already-expanded disclosure menu. */
export function shouldEnterMenuOnTab(key: string, expanded: boolean): boolean {
  return key === "Tab" && expanded;
}

/**
 * Where Tab leaves an open menu's panel from link `index` of `count`: "button" for Shift+Tab on its first link (back
 * to the menu's button), "after" for Tab on its last link (on to what follows the button), null when the focus stays
 * in the panel and the browser's own order is right.
 */
export function tabOutOfMenu(shift: boolean, index: number, count: number): "button" | "after" | null {
  if (!Number.isInteger(count) || count <= 0 || !Number.isInteger(index) || index < 0 || index >= count) return null;
  if (shift) return index === 0 ? "button" : null;
  return index === count - 1 ? "after" : null;
}
