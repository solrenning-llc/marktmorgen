/**
 * The shapes and the short helpers of the key-family registry
 * (lib/data-families.ts, whose entries live one file per topic in
 * lib/data-families/). What each closing kind means is said in
 * lib/data-families.ts, above CLOSING.
 */

/** What becomes of a family when its store closes (lib/data-families.ts, CLOSING). */
export type Closing =
  | { how: "erase"; rest?: number; by?: "handle" }
  | { how: "token"; via: string; rest?: number }
  | { how: "expires"; days: number }
  | { how: "lapses"; days: number }
  | { how: "detach"; via: string }
  | { how: "index" }
  | { how: "company"; rest?: number };

/** One topic's families (lib/data-families/<topic>.ts): each part as lib/data-families.ts says; an empty part is left out. */
export type TopicFamilies = {
  readonly counted?: readonly string[];
  readonly elsewhere?: readonly string[];
  readonly closing?: Readonly<Record<string, Closing>>;
  readonly followed?: readonly string[];
};

export const E: Closing = { how: "erase" };
export const er = (rest: number): Closing => ({ how: "erase", rest });
export const X = (days: number): Closing => ({ how: "expires", days });
export const T = (via: string, rest?: number): Closing => ({ how: "token", via, ...(rest ? { rest } : {}) });
export const D = (via: string): Closing => ({ how: "detach", via });
export const I: Closing = { how: "index" };
export const C: Closing = { how: "company" };
export const Cr = (rest: number): Closing => ({ how: "company", rest });
/** A person's record across stores: the quarter written in and twelve after (lib/joined-stores.ts, QUARTERS_KEPT), at most 31 days a month. */
export const L: Closing = { how: "lapses", days: 13 * 3 * 31 };
