/**
 * The key families a store's data room counts, by the start of their names,
 * for the jobs that measure what a store keeps (lib/data-recount.ts).
 *
 * tests/store-data-registry.ts says how every key family the code makes is
 * bounded; that file is the tests', so the code reads these two lists, and
 * tests/data-recount.test.ts fails when they no longer say what the registry
 * says: COUNTED holds every family counted in the room (taken where it is
 * written, or kept by an order), ELSEWHERE every other one (expiring by
 * itself, capped, the company's, or priced by another line). A key belongs
 * to the family whose name is the longest start of its own.
 *
 * The entries live one file per topic (the first part of a family's name
 * after "nl:") in lib/data-families/<topic>.ts, read here through the
 * generated lib/data-families/index.ts (node scripts/data-families-index.mjs,
 * held by tests/data-families-index.test.ts), so two changes adding families
 * of different topics never edit the same lines (C2-213).
 */

import type { Closing } from "@/lib/data-family-kinds";
import { ALL_TOPICS } from "@/lib/data-families/index";

export type { Closing } from "@/lib/data-family-kinds";

/** Families counted in a store's data room. */
export const COUNTED_FAMILIES: readonly string[] = ALL_TOPICS.flatMap((topic) => topic.counted ?? []);

/** Families bounded some other way, which a measure of the room leaves out. */
export const ELSEWHERE_FAMILIES: readonly string[] = ALL_TOPICS.flatMap((topic) => topic.elsewhere ?? []);

/** Whether a key belongs to a family the room counts: the longest family name it starts with is one of COUNTED_FAMILIES. */
export function countedInRoom(key: string): boolean {
  let best = "";
  let counted = false;
  for (const name of COUNTED_FAMILIES) if (key.startsWith(name) && name.length > best.length) [best, counted] = [name, true];
  for (const name of ELSEWHERE_FAMILIES) if (key.startsWith(name) && name.length > best.length) [best, counted] = [name, false];
  return counted;
}

/**
 * What becomes of each family when a store closes (added 18 October 2026):
 * its files go on its closing day (lib/plan-closing.ts), and every record it
 * keeps here goes within ERASE_WITHIN_DAYS after (lib/closed-store-data.ts),
 * but for what CLOSING says is kept. tests/closing-families.test.ts fails
 * for a family of tests/store-data-registry.ts that has no rule here, for a
 * rule here that names no family, and for a rule that does not fit how the
 * registry says the family is bounded.
 *
 *   erase    the store's own keys, named by one of its ids (or, `by`, its
 *            address or its key), are deleted by the walk. `rest`: the days
 *            within which any other key of the family (a payment's, a
 *            token's, a person's, which names no store) is gone by itself.
 *   token    named by a token, not by the store: deleted through what the
 *            store's own record of it says (the follower of family `via`,
 *            lib/closed-store-data.ts), and otherwise gone within `rest` days.
 *   expires  names no store and holds none of its content: gone by itself
 *            within `days`.
 *   lapses   a person's own record across stores (lib/joined-stores.ts),
 *            in which the store's id is one member among others: not taken
 *            out buyer by buyer, because once the store is gone the id
 *            points at nothing and is never shown; it runs out by itself
 *            within `days` of being written, priced with what wrote it.
 *   detach   one person's or one account's, across stores: only this
 *            store's member is taken out (by the step `via`).
 *   index    a list of the company's that names stores: this store's
 *            members are taken out by the walk.
 *   company  the company's own record, a person's own sign-in, or the
 *            store's address held back from anyone else: kept, as the
 *            registry says why; `rest` when it is gone by itself.
 *
 * Each topic file writes these with the short helpers of
 * lib/data-family-kinds.ts (E, er, X, T, D, I, C, Cr, L).
 */
export const CLOSING: Readonly<Record<string, Closing>> = Object.assign({}, ...ALL_TOPICS.map((topic) => topic.closing ?? {}));

/**
 * The families whose keys a closing store's follower reads before the walk
 * deletes them (lib/closed-store-data.ts, FOLLOWERS): named here so what they
 * read can be priced without the walk (tests/plan-cost-registry.ts, closure).
 */
export const FOLLOWED_FAMILIES: readonly string[] = ALL_TOPICS.flatMap((topic) => topic.followed ?? []);

/** The family a key belongs to, by the longest name it starts with; "" for none. */
export function closingFamilyOf(key: string): string {
  let best = "";
  for (const name of Object.keys(CLOSING)) if (key.startsWith(name) && name.length > best.length) best = name;
  return best;
}

/** What becomes of a key when its store closes; a key of no family is left as it is. */
export function closingOf(key: string): Closing | null {
  const family = closingFamilyOf(key);
  return family ? CLOSING[family] : null;
}
