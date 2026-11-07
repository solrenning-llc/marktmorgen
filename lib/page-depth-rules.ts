/** How far a page is read, the figures (lib/page-depth.ts). Pure. */

/** The time ranges' own record beside the blocks' (639 [GL7](25)): six fields at most, with their key. */
const TIME_RECORD_BYTES_BESIDE = 6 * 96 + 128;

/**
 * The most fields one page's record may have (since 18 October 2026): a
 * field is a block, with the answer and the video step a visitor sent, and
 * every new one was kept for a year, however many a request named. Past
 * this a new one is counted under "~" (lib/capped-count.ts).
 */
export const DEPTH_FIELDS_MAX = 120;
/**
 * What a page's record can weigh at the most, in bytes: its fields of up to
 * 44 characters, each with its count and what Redis keeps beside it, and the
 * key. Counted in the store's data room with its product from the day the
 * product is made, and for as long as the store is once it is deleted,
 * because a page already drawn can still send its reading (lib/store.ts).
 */
export const DEPTH_RECORD_BYTES = (DEPTH_FIELDS_MAX + 1) * 96 + 128 + TIME_RECORD_BYTES_BESIDE;

/**
 * How long a measured visitor stayed on a sales page (639 [GL7](25)): the
 * seconds the page was open in front of them before they left or switched
 * away, counted in one of these ranges, never as a number of its own, in a
 * record of its own beside the blocks' (so it can never push a block into the
 * overflow field, nor be counted as a visitor), at most TIME_RANGES.length
 * fields. No cookie and nothing about the visitor: only which range.
 */
export const TIME_RANGES = [
  { field: "@t0", upTo: 10, words: "Under 10 seconds" },
  { field: "@t1", upTo: 30, words: "10 to 30 seconds" },
  { field: "@t2", upTo: 60, words: "30 seconds to 1 minute" },
  { field: "@t3", upTo: 180, words: "1 to 3 minutes" },
  { field: "@t4", upTo: 600, words: "3 to 10 minutes" },
  { field: "@t5", upTo: Infinity, words: "10 minutes or more" },
] as const;

/** The field a stay of this many seconds is counted under, or null when it is not a time a page could have been open (negative, not a number, over a day). */
export function timeField(seconds: unknown): string | null {
  const n = typeof seconds === "number" ? seconds : typeof seconds === "string" && seconds.trim() ? Number(seconds) : NaN;
  if (!Number.isFinite(n) || n < 0 || n > 86_400) return null;
  return TIME_RANGES.find((range) => n < range.upTo)?.field ?? null;
}

/** Each range with how many of the measured visitors stayed that long and their share (0–100), from the record's counts. */
export function timeShares(counts: Record<string, number>): { words: string; count: number; share: number }[] {
  const total = TIME_RANGES.reduce((sum, range) => sum + (counts[range.field] ?? 0), 0);
  return TIME_RANGES.map((range) => {
    const count = counts[range.field] ?? 0;
    return { words: range.words, count, share: total ? Math.round((count / total) * 100) : 0 };
  });
}
