/**
 * How a file's rows go to the server in batches (components/import-tool.tsx, app/api/store/import/route.ts). Pure:
 * read on the page and on the server alike, so both hold to the same two limits.
 *
 * A batch was once cut by rows alone (a thousand). The server refuses a request heavier than BATCH_BYTES, and a
 * product row may carry a description of up to ten thousand characters and a link of two thousand: 500 products
 * with long descriptions, inside every limit an import states, weighed more than one request takes, and the whole
 * file was refused with "try again", which failed the same way. Batches are now cut by weight as well.
 */

/** Rows one upload request may carry. */
export const BATCH_ROWS = 1_000;
/** The most an upload request may weigh. */
export const BATCH_BYTES = 1_000_000;

const encoder = new TextEncoder();
const weight = (value: unknown): number => encoder.encode(JSON.stringify(value)).length;

/**
 * Splits `rows` into [from, to) ranges, each at most BATCH_ROWS rows, such that the request `body(slice)` weighs at
 * most BATCH_BYTES. `body` is the exact object the page sends for a slice (its rows included); a range is grown one
 * row at a time while the body still fits. Null when a single row cannot fit in a request on its own: the caller says
 * so, rather than sending a request the server is sure to refuse.
 */
export function importBatches(rows: string[][], body: (slice: string[][]) => unknown): [number, number][] | null {
  const ranges: [number, number][] = [];
  const empty = weight(body([]));
  let from = 0;
  while (from < rows.length) {
    let to = from;
    // Each row adds its own JSON and, after the first, one comma.
    let size = empty;
    while (to < rows.length && to - from < BATCH_ROWS) {
      const next = size + weight(rows[to]) + (to > from ? 1 : 0);
      if (next > BATCH_BYTES) break;
      size = next;
      to += 1;
    }
    if (to === from) return null;
    ranges.push([from, to]);
    from = to;
  }
  return ranges;
}
