/**
 * The page editor's preview, as on a computer or as on a phone (375 [TB1],
 * complement of 29 October 2026: "prévia lado a lado de computador e celular,
 * alternável com um clique"). Pure, so the widths and the shrinking are
 * checked without a browser (tests/preview-screen.test.ts).
 *
 * The preview is laid out at the real width of each screen, so what the page
 * does at that width (a row of columns becoming one, a block shown on phones
 * only or on computers only) is decided by the width of the page itself, as on
 * the live page: .sp-body is the container its container queries read
 * (app/globals.css). It is then shrunk, never cut, to fit the editor's column.
 */

export type PreviewScreen = "computer" | "phone";

/** In the order the switch shows them. */
export const PREVIEW_SCREENS: readonly PreviewScreen[] = ["computer", "phone"];

export const PREVIEW_SCREEN_LABEL: Record<PreviewScreen, string> = {
  computer: "Computer",
  phone: "Phone",
};

/** The width each preview is laid out at, in CSS pixels: a common phone, and a small laptop's window. */
export const PREVIEW_FRAME_WIDTH: Record<PreviewScreen, number> = {
  phone: 390,
  computer: 1024,
};

/**
 * The widest the page's text column grows on a computer: the live product
 * page's own column (max-w-3xl, 48rem, in app/[handle]/p/[product]/page.tsx).
 */
export const COMPUTER_BODY_MAX = 768;

/** The page's side padding inside the preview (px-4), as the live page's main column has. */
export const PREVIEW_BODY_PADDING = 16;

/** The width .sp-body's container queries see in each preview. */
export function previewContainerWidth(screen: PreviewScreen): number {
  const frame = PREVIEW_FRAME_WIDTH[screen];
  const body = screen === "computer" ? Math.min(frame, COMPUTER_BODY_MAX) : frame;
  return body - 2 * PREVIEW_BODY_PADDING;
}

/**
 * The least the preview is shrunk to: a tenth. A room narrower than a tenth of
 * the frame (39 pixels for a phone, 103 for a computer) is no editor column,
 * only a moment of layout, and must not draw the page at nothing.
 */
export const MIN_PREVIEW_SCALE = 0.1;

/**
 * How much the preview is shrunk to fit `room` pixels: 1 when it fits or the
 * room is not measured yet, otherwise the room over the frame's width, rounded
 * down so the shrunk page is never wider than its room (for every room of at
 * least a tenth of the frame), and never below MIN_PREVIEW_SCALE. Never enlarged.
 */
export function fitScale(room: number, frame: number): number {
  if (!(room > 0) || !(frame > 0) || room >= frame) return 1;
  return Math.max(MIN_PREVIEW_SCALE, Math.floor((room / frame) * 1000) / 1000);
}

/**
 * How much wider a measured room must be before it is taken: a scrollbar's
 * width, with some to spare. The page beside the blocks scrolls; a scrollbar
 * that appears takes ~15 pixels, the page shrinks, may then fit, the scrollbar
 * goes, and taking the wider room back would shrink less, bring the scrollbar
 * back, and so on. A narrower room is always taken at once, so the shrunk page
 * is never wider than its room.
 */
export const ROOM_TOLERANCE = 20;

/** The room to shrink to, given the one in use and a new measure (0 or less: not measured). */
export function nextRoom(current: number, measured: number): number {
  if (!(measured > 0)) return current;
  if (!(current > 0) || measured < current) return measured;
  return measured - current > ROOM_TOLERANCE ? measured : current;
}

/** The height the shrunk preview takes in the editor, so nothing is cut and no empty space is left below it. */
export function shrunkHeight(height: number, scale: number): number {
  return Math.ceil(Math.max(0, height) * scale);
}

/** The words under a shrunk preview, or null when it is shown at its real size. */
export function shrunkNote(scale: number): string | null {
  return scale < 1 ? `Shown at ${Math.floor(scale * 100)}% of its size, to fit here.` : null;
}

/** Where the choice is remembered, in this browser only, as a convenience. */
export const PREVIEW_SCREEN_KEY = "mm:page-preview-screen";

/** The remembered choice, read back; anything else, or nothing, is no choice yet. */
export function readPreviewScreen(saved: string | null | undefined): PreviewScreen | null {
  return saved === "phone" || saved === "computer" ? saved : null;
}

/** Where a preview is drawn: in the narrow column beside the blocks, or as the full Preview view. */
export type PreviewPlace = "beside" | "full";

/**
 * What each place shows until a choice is made: the column beside the blocks
 * is a phone's width and its scroll bar (25.5rem), so a phone is shown there at its real
 * size, where a computer would be shrunk to about a third, its text too small
 * to read; the full Preview view has a computer's room.
 */
export const PREVIEW_DEFAULT: Record<PreviewPlace, PreviewScreen> = {
  beside: "phone",
  full: "computer",
};

/** The screen a place shows: the one chosen, in both places alike, or that place's default while none is. */
export function screenFor(place: PreviewPlace, chosen: PreviewScreen | null): PreviewScreen {
  return chosen ?? PREVIEW_DEFAULT[place];
}
