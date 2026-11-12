/**
 * A search on the store page that pays for what it reads, without shutting a
 * buyer out (C1 cost audit, 12 November 2026; reviews of #4172).
 *
 * A search used to read the listing of every visible product the store record
 * does not carry (up to MAX_PRODUCTS, 2,000) on every query, counted as one
 * public request. Paying that full read on every search (the first version of
 * #4172) put about 64 units on one visitor's share for one query, so a real
 * buyer on a large store was refused the whole store after four searches.
 *
 * Now the full read is done once for everybody and kept short: an index of
 * each visible product's id, title and one-line summary, under one key for
 * SEARCH_INDEX_SECONDS, paid against the store's window as shared work
 * ({ shared: true }, as lib/affiliate-page-admission.ts pays), never against
 * the visitor's own share. A search reads that one key, finds the matches,
 * then pays for and reads only the matches it shows (at most
 * STORE_SEARCH_LIMIT) and, separately, the products they offer at checkout
 * (at most STORE_SEARCH_LIMIT × MAX_BUMPS), each before it is read.
 *
 * Never stale in what it shows: the index is keyed to the exact list of
 * visible products (a product added, hidden or moved builds a new one), and
 * every match is read fresh and checked again against the words, so a title
 * changed within the ten minutes never shows a product that no longer
 * matches. A product renamed so that it now matches is found once the index is
 * rebuilt, within SEARCH_INDEX_SECONDS.
 */
import { createHash } from "node:crypto";
import type { Store } from "@/lib/store";
import { type Listing, STORE_SEARCH_LIMIT, matchesSearch, readListings, visibleIds } from "@/lib/catalog";
import { listingsToRead } from "@/lib/catalog-read-count";
import { bumpTargets } from "@/lib/product-extras";
import { listingUnits } from "@/lib/public-read-rules";
import { isRedisConfigured, redisPipeline } from "@/lib/redis";
import { repliesFor } from "@/lib/redis-reply";
import { takePublicRequest } from "@/lib/traffic";

/** How long a store's search index is kept: new products are found by a search within this time. */
export const SEARCH_INDEX_SECONDS = 600;
/** The largest index kept: a larger one (long titles and summaries in many scripts) is used for that search and not kept. */
export const SEARCH_INDEX_MAX_BYTES = 1_048_576;

export const searchIndexKey = (store: Pick<Store, "sid" | "handle">): string => `nl:search:${store.sid || `h:${store.handle}`}`;

type Entry = { title: string; summary: string };

/** The exact list of visible products, in order, as the index is keyed to it. */
const signatureOf = (ids: string[]): string => createHash("sha256").update(ids.join("\n")).digest("hex").slice(0, 32);

/** The kept index for this exact list of visible products, or null when there is none or it does not read. */
async function readIndex(key: string, signature: string): Promise<Map<string, Entry> | null> {
  try {
    const replies = repliesFor(await redisPipeline([["GET", key]]), 1);
    const raw = replies?.[0];
    if (typeof raw !== "string") return null;
    const kept = JSON.parse(raw) as { sig?: unknown; rows?: unknown };
    if (kept.sig !== signature || !Array.isArray(kept.rows)) return null;
    const index = new Map<string, Entry>();
    for (const row of kept.rows) {
      if (!Array.isArray(row) || row.length !== 3 || !row.every((cell) => typeof cell === "string")) return null;
      index.set(row[0], { title: row[1], summary: row[2] });
    }
    return index;
  } catch {
    return null;
  }
}

/** Reads every visible listing once, paid as shared work, and keeps the index; null when the store's window refuses it. */
async function buildIndex(store: Store, visible: string[], key: string, signature: string): Promise<{ index: Map<string, Entry>; read: Map<string, Listing> } | null> {
  const units = listingUnits(listingsToRead(store, visible));
  if (units > 0 && !(await takePublicRequest(store, "public", undefined, units, { shared: true }))) return null;
  const all = await readListings(store, visible);
  const index = new Map(all.map((listing) => [listing.id, { title: listing.title, summary: listing.summary }]));
  if (units > 0 && isRedisConfigured()) {
    const rows = all.map((listing) => [listing.id, listing.title, listing.summary]);
    const value = JSON.stringify({ sig: signature, rows });
    if (Buffer.byteLength(value) <= SEARCH_INDEX_MAX_BYTES) {
      await redisPipeline([["SET", key, value, "EX", SEARCH_INDEX_SECONDS]]).catch((error) => console.error("store search: keeping the index failed", error));
    }
  }
  return { index, read: new Map(all.map((listing) => [listing.id, listing])) };
}

/** Pays for reading `ids` (at least one request when any is read from Redis) and reads them; null when refused. */
async function paidRead(store: Store, ids: string[], minimum: number): Promise<Listing[] | null> {
  if (ids.length === 0) return [];
  const toRead = listingsToRead(store, ids);
  const units = toRead > 0 ? Math.max(minimum, listingUnits(toRead)) : 0;
  if (units > 0 && !(await takePublicRequest(store, "public", undefined, units))) return null;
  return readListings(store, ids);
}

/**
 * The store page's search: the matches in the creator's order, at most
 * STORE_SEARCH_LIMIT, with what they offer at checkout. Null when the store's
 * window refuses the search (nothing of it is read); `related` is empty when
 * only the checkout boxes are refused.
 */
export async function searchStorePaid(store: Store, query: string): Promise<{ listings: Listing[]; related: Listing[]; total: number } | null> {
  const visible = visibleIds(store);
  const key = searchIndexKey(store);
  const signature = signatureOf(visible);
  // A store whose record carries every listing reads nothing for the index, and keeps none.
  const fromRecord = listingsToRead(store, visible) === 0;
  const kept = fromRecord ? null : await readIndex(key, signature);
  const built = kept ? null : await buildIndex(store, visible, key, signature);
  const index = kept ?? built?.index;
  if (!index) return null;
  const found = visible.filter((id) => {
    const entry = index.get(id);
    return entry !== undefined && matchesSearch(entry, query);
  });
  // Just built: the matches are already read. Otherwise each is read fresh, paid first; the index read itself is one
  // command, paid with them (at least one request when any is read from Redis).
  const shownIds = found.slice(0, STORE_SEARCH_LIMIT);
  const fresh = built ? shownIds.map((id) => built.read.get(id)).filter((listing): listing is Listing => Boolean(listing)) : await paidRead(store, shownIds, 1);
  if (!fresh) return null;
  const listings = fresh.filter((listing) => matchesSearch(listing, query));
  const shown = new Set(listings.map((listing) => listing.id));
  const targets = [...new Set(listings.flatMap((listing) => bumpTargets(listing).filter((id) => !shown.has(id))))];
  // Just built: the boxes' products the index read are taken from it; only the others are paid for and read.
  const have = built ? targets.map((id) => built.read.get(id)).filter((listing): listing is Listing => Boolean(listing)) : [];
  const missing = built ? targets.filter((id) => !built.read.has(id)) : targets;
  const related = [...have, ...((await paidRead(store, missing, 0)) ?? [])];
  return { listings, related, total: found.length - (fresh.length - listings.length) };
}
