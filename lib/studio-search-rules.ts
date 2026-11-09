// RED stub: 766 [STN13] unit 1; the rules come in the next commit.
export const MIN_QUERY = 0;
export const MAX_QUERY = 0;
export const SEARCH_DELAY_MS = 0;
export const PER_GROUP = 0;
export const SEARCHES_PER_MINUTE = 0;
export const SEARCHES_PER_DAY = 0;
export const ANSWERS_KEPT = 0;
export type GroupId = "products" | "pages" | "tools";
export type GroupState = "ok" | "partial" | "unknown";
export type SearchResult = { id: string; title: string; detail: string; href: string };
export type SearchGroup = { id: GroupId; title: string; state: GroupState; missing: number; results: SearchResult[] };
export type SearchAnswer = { groups: SearchGroup[] };
export type Timers = { set: (fn: () => void, ms: number) => unknown; clear: (handle: unknown) => void };
export function cleanQuery(_raw: unknown): string | null { return null; }
export function isAddress(_q: string): boolean { return false; }
export function hasAt(_q: string): boolean { return false; }
export function matchRank(_item: { title: string; extra?: string }, _query: string): number { return -1; }
export function pickMatches<T>(_items: readonly T[], _query: string, _textOf: (item: T) => { title: string; extra?: string }, _limit = PER_GROUP): T[] { return []; }
export function answerSentence(_answer: SearchAnswer, _query: string): string { return ""; }
export function searchScheduler<T>(_o: { run: (q: string, signal: AbortSignal) => Promise<T>; answer: (q: string, value: T) => void; failed: (q: string, error: unknown) => void; ok: (value: T) => boolean; timers?: Timers; delay?: number }): { type: (q: string | null) => void; stop: () => void } {
  return { type: () => {}, stop: () => {} };
}
