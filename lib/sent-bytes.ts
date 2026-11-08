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

/**
 * The fifty kilobytes one studio request's own price moves (PAGE_INCLUDED_BYTES),
 * spent once for the whole request (C3-112 (2)): a page that reads or sends
 * several parts (the buyers page's agenda, its tasks, its reading of the
 * buyers and what it sends on) makes one and hands it to each, so the included
 * bytes are never counted once a part. A part that fits in what is left counts
 * nothing beyond the request and spends that much; a part that does not fit
 * counts, by itself, one studio request each `perUnit` bytes, every byte of it
 * (exactly what it counted before alone), and leaves what is left to a later,
 * smaller part. So no part counts less than it did alone, and all the parts of
 * a request move at most PAGE_INCLUDED_BYTES without a request of their own.
 * Asked before each part is read or sent; an unknown size is never none.
 */
export class IncludedBytes {
  #left = PAGE_INCLUDED_BYTES;

  /** Bytes still within the request's own price. */
  get left(): number {
    return this.#left;
  }

  /**
   * Studio requests `bytes` costs beyond the request's own, at one each
   * `perUnit` bytes past what is left; and how many bytes those (or the
   * included bytes it spent) cover, which is as far as the part may be read.
   */
  take(bytes: number, perUnit: number): { units: number; covers: number } {
    if (!Number.isSafeInteger(bytes) || bytes < 0) throw new RangeError(`unknown size: ${bytes}`);
    if (!Number.isSafeInteger(perUnit) || perUnit <= 0) throw new RangeError(`unknown rate: ${perUnit}`);
    if (bytes <= this.#left) {
      this.#left -= bytes;
      return { units: 0, covers: bytes };
    }
    const units = Math.ceil(bytes / perUnit);
    return { units, covers: units * perUnit };
  }
}

/**
 * Studio requests sending `bytes` costs beyond the request's own: none within
 * what is left of its included bytes (`included`, one per request; a fresh one
 * when the sending is the request's only part), then one a megabyte.
 */
export function sentUnits(bytes: number, included: IncludedBytes = new IncludedBytes()): number {
  return included.take(bytes, STUDIO_UNIT_SENT_BYTES).units;
}
