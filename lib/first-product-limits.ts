/**
 * How much a first product made in the studio may hold (490 [PP1], unit 2): the screen
 * (components/first-product-maker.tsx) shows these limits and the server (lib/first-product-pdf.ts) refuses past
 * them, so both read the same numbers. Browser-safe: plain numbers.
 */

/** The most characters one part may hold. */
export const FIRST_PRODUCT_MAX_PART = 4_000;
/** The most characters the whole file may hold, title and headings included. */
export const FIRST_PRODUCT_MAX_TEXT = 60_000;
/** The longest title, heading or group name. */
export const FIRST_PRODUCT_MAX_HEADING = 120;
/**
 * The most line breaks the whole file may hold: each one starts a line on the page, so a text of nothing but
 * breaks would otherwise be hundreds of pages from a few thousand characters. Runs of empty lines count as one.
 */
export const FIRST_PRODUCT_MAX_BREAKS = 600;
/**
 * The formats whose PDF holds everything their outline describes today: a guide is headings and paragraphs. A
 * checklist's boxes to tick, a workbook's room for answers and a template's fields to fill are not drawn yet, so
 * those formats are not offered or made until they are (independent review, 12 November 2026).
 */
export const FIRST_PRODUCT_MADE_FORMATS = ["guide"] as const;
