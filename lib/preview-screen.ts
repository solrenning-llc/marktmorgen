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

/** In the order the switch shows them; the first is the default. */
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
 * How much the preview is shrunk to fit `room` pixels: 1 when it fits or the
 * room is not measured yet, otherwise the room over the frame's width, rounded
 * down so the shrunk page is never wider than its room. Never enlarged.
 */
export function fitScale(room: number, frame: number): number {
  if (!(room > 0) || !(frame > 0) || room >= frame) return 1;
  return Math.floor((room / frame) * 1000) / 1000;
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

/** The remembered choice, read back; anything else, or nothing, is the default. */
export function readPreviewScreen(saved: string | null | undefined): PreviewScreen {
  return saved === "phone" ? "phone" : "computer";
}
