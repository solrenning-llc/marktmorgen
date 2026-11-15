/**
 * The "More from <store>" shelf on a course (628 [HN4](b), unit 1; owner's
 * Hotmart audit): up to MAX_SHELF products the creator picks, shown to a
 * student on the course's home page. Pure and browser-safe; the studio's
 * choice and the page come in the next units.
 *
 * What a student is shown, and what never:
 *
 *   - only products the store lists now (not drafts), at their published
 *     price, in the creator's order, never the course itself;
 *   - never something this student already has; and when what they have
 *     cannot be read, nothing at all, rather than offering them something
 *     they may have paid for;
 *   - nothing invented: no discount, count, rating or scarcity; just the
 *     product's own card.
 *
 * Nothing on it appears inside a lesson or moves by itself: it is a list on
 * the course's front page that a student reads when they choose to.
 */

/** The most products one course's shelf may hold. */
export const MAX_SHELF = 6;

const PRODUCT_ID = /^[a-z0-9]{6,40}$/;

/** A shelf as sent or kept: product ids, each once, at most MAX_SHELF, never the course's own product. */
export function readShelf(raw: unknown, courseProductId = ""): string[] {
  if (!Array.isArray(raw)) return [];
  const out: string[] = [];
  for (const value of raw) {
    if (typeof value !== "string" || !PRODUCT_ID.test(value) || value === courseProductId || out.includes(value)) continue;
    out.push(value);
    if (out.length === MAX_SHELF) break;
  }
  return out;
}

/**
 * What a student is shown: the shelf's products the store lists now, in the
 * shelf's order, less the course and anything the student owns. `owned` null
 * means it could not be read: then nothing is shown.
 */
export function shelfFor(shelf: readonly string[], listed: ReadonlySet<string>, owned: ReadonlySet<string> | null, courseProductId: string): string[] {
  if (owned === null) return [];
  return shelf.filter((id) => id !== courseProductId && listed.has(id) && !owned.has(id)).slice(0, MAX_SHELF);
}
