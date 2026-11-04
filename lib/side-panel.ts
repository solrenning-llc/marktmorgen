/**
 * The page editor's right-hand column on a wide screen (375 [TB1]): the side
 * menu of blocks to add and the page as visitors see it share it, one at a
 * time, switched at its top. Seen in a browser at 1280 pixels: with the menu
 * (15rem) and the page (24.5rem) as two columns of their own, the column the
 * blocks are edited in was left 182 pixels, too narrow for its own fields
 * ("Add to column 1" cut its choices, a row's first field was 31 pixels).
 * Pure, so tests/side-panel.test.ts checks the choice and the arithmetic.
 */

export type SidePanel = "add" | "preview";

/** In the order the switch shows them. */
export const SIDE_PANELS: readonly SidePanel[] = ["add", "preview"];

export const SIDE_PANEL_LABEL: Record<SidePanel, string> = {
  add: "Add blocks",
  preview: "Preview",
};

/** Until a choice is made: the page as visitors see it, as the editor showed it before the side menu. */
export const SIDE_PANEL_DEFAULT: SidePanel = "preview";

/** Where the choice is remembered, in this browser only, as a convenience. */
export const SIDE_PANEL_KEY = "mm:page-side-panel";

/** The remembered choice, read back; anything else, or nothing, is the default. */
export function readSidePanel(saved: string | null | undefined): SidePanel {
  return saved === "add" || saved === "preview" ? saved : SIDE_PANEL_DEFAULT;
}

/** The right-hand column's width, in pixels (24.5rem: a phone's 390 pixels at their real size). */
export const SIDE_COLUMN_PX = 24.5 * 16;

/** The gap between the two columns (gap-5). */
export const SIDE_GAP_PX = 20;

/**
 * The least the column the blocks are edited in may be, beside the shared
 * column: wide enough for "Add to column 1" to show "Smaller heading" whole
 * (about 119 pixels) beside a row's columns, and for a row's fields.
 */
export const EDIT_COLUMN_MIN_PX = 420;

/**
 * The editor's width at the narrowest wide screen (1280 pixels), as measured
 * in a browser on 4 November 2026: 182 + 240 + 392 + 2 × 20 pixels with the
 * three columns. The studio's own navigation and margins take the rest.
 */
export const EDITOR_WIDTH_AT_1280 = 854;

/** The column the blocks are edited in, given the editor's width. */
export function editColumnWidth(editor: number): number {
  return Math.max(0, editor - SIDE_COLUMN_PX - SIDE_GAP_PX);
}
