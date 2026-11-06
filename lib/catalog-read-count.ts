/**
 * How many listings lib/catalog.ts readListings reads from the database for
 * some ids, counted from the store record alone, so a reading that pays for
 * its size first (lib/api-read.ts, lib/mcp-tools.ts) can take it before it
 * reads. Pure: no reads here.
 *
 * The same rule as readListings: the ids asked for (every product in the
 * creator's order when none are given), only those the store has, each once,
 * in the order asked; a store whose products are in its own record (inline),
 * or that has no catalog to read from, reads none; the listings the record's
 * head already holds are not read again. tests/catalog-read-count.test.ts
 * holds it to what readListings really reads.
 */
import { productIds } from "@/lib/catalog";
import type { Store } from "@/lib/store";

/** The ids readListings answers for, in order: the store's own, each once. */
function askedIds(store: Store, ids: Iterable<string> | undefined): string[] {
  const own = productIds(store);
  if (ids === undefined) return [...new Set(own)];
  const known = new Set(own);
  const out = new Set<string>();
  for (const id of ids) if (typeof id === "string" && known.has(id)) out.add(id);
  return [...out];
}

/** How many listings readListings reads from the database for these ids: those the store's own record does not hold. */
export function listingsToRead(store: Store, ids?: Iterable<string>): number {
  const catalog = store.catalog;
  if (catalog.inline || !catalog.id) return 0;
  const head = new Set(catalog.head.map((listing) => listing.id));
  return askedIds(store, ids).filter((id) => !head.has(id)).length;
}
