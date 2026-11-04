/**
 * What a studio page sends on to the browser, measured as Next sends it,
 * and the studio requests that costs beyond the page's own (639 [GL7](4),
 * (6)). Browser-safe.
 */

/** Bytes sent on to the browser that one studio request covers (tests/plan-cost-registry.ts, STUDIO_UNIT_SENT). */
export const STUDIO_UNIT_SENT_BYTES = 1_000_000;
/** What a page sends, or reads, within its own studio request (UNIT_COST.studio prices fifty kilobytes). */
export const PAGE_INCLUDED_BYTES = 50_000;

const utf8 = (text: string) => new TextEncoder().encode(text).length;

/** Bytes of `text` written in the page's HTML, escaped (an "&" is "&amp;"). */
export function htmlBytes(text: string): number {
  return utf8(text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;"));
}

/**
 * What the records' JSON is sent as, in bytes: the page's text, HTML-escaped,
 * and React's copy, a JSON string with "<", ">", "&", U+2028 and U+2029
 * written as six-byte \uXXXX escapes.
 */
export function sentBytes(json: string): number {
  return htmlBytes(json) + utf8(JSON.stringify(json).replace(/[<>&\u2028\u2029]/g, "\\u0000"));
}

/** Studio requests sending `bytes` costs beyond the page's own: none within PAGE_INCLUDED_BYTES, then one a megabyte. */
export function sentUnits(bytes: number): number {
  return bytes <= PAGE_INCLUDED_BYTES ? 0 : Math.ceil(bytes / STUDIO_UNIT_SENT_BYTES);
}
