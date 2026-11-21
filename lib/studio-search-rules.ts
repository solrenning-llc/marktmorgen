/**
 * The studio's one search box (766 [STN13], unit 1): what is searched for,
 * what matches and in which order, the sentence read out once per answer,
 * and the scheduler that keeps typing from reading per key.
 *
 * Pure and browser-safe: the box (components/studio-search.tsx) and the
 * route (app/api/store/studio-search, lib/studio-search.ts) read the same
 * rules. What a search costs is STUDIO_SEARCH_UNITS of the store's studio
 * requests (lib/studio-allowance-rules.ts), taken before it reads, with
 * SEARCHES_PER_MINUTE and SEARCHES_PER_DAY a store besides, counted before
 * them: a search those refuse takes none, so a box left typing on its own
 * cannot spend the store's month.
 *
 * A buyer is never searched here: a full address typed opens that buyer's
 * page through the studio's existing look-up (app/api/store/person), for the
 * roles that may read orders; the address never goes to this route, so it
 * never sits in an address bar or a request log.
 */

/** Fewer letters than this is no search: one letter matches nearly everything. */
export const MIN_QUERY = 2;
/** The longest search, in characters: a product's name is at most 80 (lib/catalog-rules.ts). */
export const MAX_QUERY = 80;
/** How long the box waits after the last key before it searches. */
export const SEARCH_DELAY_MS = 300;
/** The most results one group shows. */
export const PER_GROUP = 8;
/** Searches one store may make in a minute, across its whole team. */
export const SEARCHES_PER_MINUTE = 20;
/** Searches one store may make in a day, across its whole team. */
export const SEARCHES_PER_DAY = 200;
/** Answers the box keeps while the page is open, so the same words are not searched twice. */
export const ANSWERS_KEPT = 20;
/** The largest request body the route reads. */
export const SEARCH_BODY_BYTES = 512;

/** "actions": the things to do of 486 [IT3], found in the browser (lib/studio-search-actions.ts), never by the route. */
export type GroupId = "actions" | "products" | "pages" | "tools";
/** "partial": some products could not be searched yet (missing); "unknown": the group could not be read. */
export type GroupState = "ok" | "partial" | "unknown";
export type SearchResult = { id: string; title: string; detail: string; href: string };
export type SearchGroup = { id: GroupId; title: string; state: GroupState; missing: number; results: SearchResult[] };
export type SearchAnswer = { groups: SearchGroup[] };
export type Timers = { set: (fn: () => void, ms: number) => unknown; clear: (handle: unknown) => void };

/** The words searched for, tidied; null when there is nothing to search (too short, too long, not text). */
export function cleanQuery(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const query = raw.replace(/\s+/g, " ").trim();
  return query.length >= MIN_QUERY && query.length <= MAX_QUERY ? query : null;
}

/** Whether the words hold an "@": an address, whole or not, is never sent to the search route. */
export function hasAt(query: string): boolean {
  return query.includes("@");
}

/** Whether the words are one whole email address, which can open a buyer's page. */
export function isAddress(query: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(query.trim());
}

/**
 * Which result Enter opens: the chosen one, or the only one when there is
 * one and none is chosen; -1 opens nothing (several, none chosen).
 */
export function enterTarget(active: number, count: number): number {
  if (active >= 0 && active < count) return active;
  return active < 0 && count === 1 ? 0 : -1;
}

/** Words as a search compares them: no accents, no case, letters and digits only. */
function words(text: string): string[] {
  return text
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter(Boolean);
}

/**
 * How well a name matches, best first: 0 the whole name, 1 the name starts
 * with the words, 2 every word starts a word of the name, 3 every word starts
 * a word of its sentence (a tool's one line); -1 no match.
 */
export function matchRank(item: { title: string; extra?: string }, query: string): number {
  const asked = words(query);
  if (asked.length === 0) return -1;
  const title = words(item.title);
  const joinedAsked = asked.join(" ");
  const joinedTitle = title.join(" ");
  if (joinedTitle === joinedAsked) return 0;
  if (joinedTitle.startsWith(joinedAsked)) return 1;
  const within = (has: string[]) => asked.every((word) => has.some((one) => one.startsWith(word)));
  if (within(title)) return 2;
  if (item.extra && within(words(`${item.title} ${item.extra}`))) return 3;
  return -1;
}

/** The items that match, best first and in their own order when equal, at most `limit`. */
export function pickMatches<T>(items: readonly T[], query: string, textOf: (item: T) => { title: string; extra?: string }, limit = PER_GROUP): T[] {
  return items
    .map((item, at) => ({ item, at, rank: matchRank(textOf(item), query) }))
    .filter((entry) => entry.rank >= 0)
    .sort((x, y) => x.rank - y.rank || x.at - y.at)
    .slice(0, limit)
    .map((entry) => entry.item);
}

const NOUNS: Record<GroupId, [string, string]> = {
  actions: ["action", "actions"],
  products: ["product", "products"],
  pages: ["page", "pages"],
  tools: ["tool", "tools"],
};
const count = (n: number, [one, many]: [string, string]) => `${n} ${n === 1 ? one : many}`;

/**
 * The one sentence the box reads out when an answer arrives: how many of
 * each, or that nothing matches; a group that could not be read is said, and
 * then the answer is never "nothing matches".
 */
export function answerSentence(answer: SearchAnswer, query: string): string {
  const found = answer.groups.filter((group) => group.results.length > 0);
  const total = found.reduce((sum, group) => sum + group.results.length, 0);
  const unread = answer.groups.filter((group) => group.state === "unknown");
  const partial = answer.groups.filter((group) => group.state === "partial" && group.missing > 0);
  const parts: string[] = [];
  if (total > 0) parts.push(`${total} ${total === 1 ? "result" : "results"}: ${found.map((group) => count(group.results.length, NOUNS[group.id])).join(", ")}.`);
  else if (unread.length === 0) parts.push(`Nothing matches “${query}”.`);
  for (const group of unread) parts.push(`We could not search your ${NOUNS[group.id][1]} just now. Try again in a moment.`);
  for (const group of partial) parts.push(`${count(group.missing, NOUNS[group.id])} could not be searched yet. Open Sales pages once and they can be.`);
  return parts.join(" ");
}

/**
 * Typing, turned into searches: one search SEARCH_DELAY_MS after the last
 * key, never one per key; the one still waiting is stopped when the words
 * change; words already answered are answered again from memory (the last
 * ANSWERS_KEPT), with no search. `type(null)` stops everything. Only answers
 * `ok` says are good are kept.
 */
export function searchScheduler<T>(o: {
  run: (q: string, signal: AbortSignal) => Promise<T>;
  answer: (q: string, value: T) => void;
  failed: (q: string, error: unknown) => void;
  ok: (value: T) => boolean;
  timers?: Timers;
  delay?: number;
}): { type: (q: string | null) => void; stop: () => void } {
  const timers: Timers = o.timers ?? { set: (fn, ms) => setTimeout(fn, ms), clear: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>) };
  const delay = o.delay ?? SEARCH_DELAY_MS;
  const kept = new Map<string, T>();
  let waiting: unknown = null;
  let running: AbortController | null = null;
  const stop = () => {
    if (waiting !== null) timers.clear(waiting);
    waiting = null;
    running?.abort();
    running = null;
  };
  const type = (q: string | null) => {
    stop();
    if (q === null) return;
    const known = kept.get(q);
    if (known !== undefined) {
      o.answer(q, known);
      return;
    }
    waiting = timers.set(() => {
      waiting = null;
      const controller = new AbortController();
      running = controller;
      o.run(q, controller.signal).then(
        (value) => {
          if (controller.signal.aborted) return;
          running = null;
          if (o.ok(value)) {
            kept.delete(q);
            kept.set(q, value);
            while (kept.size > ANSWERS_KEPT) kept.delete(kept.keys().next().value as string);
          }
          o.answer(q, value);
        },
        (error: unknown) => {
          if (controller.signal.aborted) return;
          running = null;
          o.failed(q, error);
        },
      );
    }, delay);
  };
  return { type, stop };
}
