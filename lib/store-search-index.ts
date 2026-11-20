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
/**
 * The largest index kept. A larger one (long titles and summaries in many scripts) is not kept and not rebuilt on
 * every search: its first build notes, under the same key and for the same time, that this list of products is too
 * large, and the store's searches are refused with an honest sentence (searchUnavailable) while its products are
 * listed as usual (review of #4172 at 45a4b04514; the coordinator's decision of 13 November 2026).
 */
export const SEARCH_INDEX_MAX_BYTES = 1_048_576;
/** How long one search holds the right to build the index (SET NX): searches meanwhile are refused, never each building it. */
export const SEARCH_BUILD_LOCK_SECONDS = 60;

export const searchIndexKey = (store: Pick<Store, "sid" | "handle">): string => `nl:search:${store.sid || `h:${store.handle}`}`;
/** The build lock: one build at a time of a store's index for one list of products (a product added builds at once). */
export const searchBuildKey = (store: Pick<Store, "sid" | "handle">, signature: string): string => `nl:search:build:${store.sid || `h:${store.handle}`}:${signature}`;

/** What a search answers when the store's index is too large to keep: search is not offered there for now. */
export const SEARCH_UNAVAILABLE = "unavailable";

type Entry = { title: string; summary: string };

/** The exact list of visible products, in order, as the index is keyed to it. */
const signatureOf = (ids: string[]): string => createHash("sha256").update(ids.join("\n")).digest("hex").slice(0, 32);

/**
 * The kept index for this exact list of visible products; "too large" when its build noted it is over
 * SEARCH_INDEX_MAX_BYTES; null when there is none or it does not read.
 */
async function readIndex(key: string, signature: string): Promise<Map<string, Entry> | "too large" | null> {
  try {
    const replies = repliesFor(await redisPipeline([["GET", key]]), 1);
    const raw = replies?.[0];
    if (typeof raw !== "string") return null;
    const kept = JSON.parse(raw) as { sig?: unknown; rows?: unknown; large?: unknown };
    if (kept.sig === signature && kept.large === true) return "too large";
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

/**
 * Reads every visible listing once, paid as shared work, and keeps the index. Null when another search is building it
 * (the build lock, SET NX, answered anything but "OK") or the store's window refuses the build; "too large" when the
 * index is over SEARCH_INDEX_MAX_BYTES, which is then noted for SEARCH_INDEX_SECONDS so no search rebuilds it.
 * The lock is taken before anything is paid or read and simply expires: a search after a build finds the index kept.
 */
async function buildIndex(store: Store, visible: string[], key: string, signature: string): Promise<{ index: Map<string, Entry>; read: Map<string, Listing> } | "too large" | null> {
  const units = listingUnits(listingsToRead(store, visible));
  if (units > 0) {
    const locked = repliesFor(await redisPipeline([["SET", searchBuildKey(store, signature), "1", "NX", "EX", SEARCH_BUILD_LOCK_SECONDS]]), 1);
    // Only an exact "OK" is this search's build; nothing (another build holds it) or a reply of another shape refuses it.
    if (!locked || locked[0] !== "OK") return null;
    if (!(await takePublicRequest(store, "public", undefined, units, { shared: true }))) return null;
  }
  const all = await readListings(store, visible);
  if (units > 0 && isRedisConfigured()) {
    const rows = all.map((listing) => [listing.id, listing.title, listing.summary]);
    const value = JSON.stringify({ sig: signature, rows });
    if (Buffer.byteLength(value) > SEARCH_INDEX_MAX_BYTES) {
      await redisPipeline([["SET", key, JSON.stringify({ sig: signature, large: true }), "EX", SEARCH_INDEX_SECONDS]]).catch((error) => console.error("store search: noting a large index failed", error));
      return "too large";
    }
    await redisPipeline([["SET", key, value, "EX", SEARCH_INDEX_SECONDS]]).catch((error) => console.error("store search: keeping the index failed", error));
  }
  const index = new Map(all.map((listing) => [listing.id, { title: listing.title, summary: listing.summary }]));
  return { index, read: new Map(all.map((listing) => [listing.id, listing])) };
}

/** Pays for reading `ids` (one request for each PUBLIC_LISTINGS_PER_UNIT read from Redis) and reads them; null when refused. */
async function paidRead(store: Store, ids: string[]): Promise<Listing[] | null> {
  if (ids.length === 0) return [];
  const units = listingUnits(listingsToRead(store, ids));
  if (units > 0 && !(await takePublicRequest(store, "public", undefined, units))) return null;
  return readListings(store, ids);
}

/**
 * The store page's search: the matches in the creator's order, at most
 * STORE_SEARCH_LIMIT, with what they offer at checkout. Null when the store's
 * window refuses the search (nothing of it is read); `related` is empty when
 * only the checkout boxes are refused.
 */
export async function searchStorePaid(store: Store, query: string): Promise<{ listings: Listing[]; related: Listing[]; total: number } | typeof SEARCH_UNAVAILABLE | null> {
  const visible = visibleIds(store);
  const key = searchIndexKey(store);
  const signature = signatureOf(visible);
  // A store whose record carries every listing reads nothing for the index, and keeps none.
  const fromRecord = listingsToRead(store, visible) === 0;
  // The kept index's read is paid before it is read (reviews of #4172, second round): one request, as a later page
  // is priced, covers its one GET of at most SEARCH_INDEX_MAX_BYTES at Upstash's paid transfer price
  // (lib/spend-cost-table.ts, UPSTASH_MICRO_USD_PER_GB_TRANSFER: 1 MiB is about $0.00003, a request $0.000063).
  if (!fromRecord && !(await takePublicRequest(store, "public", undefined, 1))) return null;
  const keptOrLarge = fromRecord ? null : await readIndex(key, signature);
  if (keptOrLarge === "too large") return SEARCH_UNAVAILABLE;
  const kept = keptOrLarge;
  const builtOrLarge = kept ? null : await buildIndex(store, visible, key, signature);
  if (builtOrLarge === "too large") return SEARCH_UNAVAILABLE;
  const built = builtOrLarge;
  const index = kept ?? built?.index;
  if (!index) return null;
  const found = visible.filter((id) => {
    const entry = index.get(id);
    return entry !== undefined && matchesSearch(entry, query);
  });
  // Just built: the matches are already read. Otherwise each is read fresh, paid first.
  const shownIds = found.slice(0, STORE_SEARCH_LIMIT);
  const fresh = built ? shownIds.map((id) => built.read.get(id)).filter((listing): listing is Listing => Boolean(listing)) : await paidRead(store, shownIds);
  if (!fresh) return null;
  const listings = fresh.filter((listing) => matchesSearch(listing, query));
  const shown = new Set(listings.map((listing) => listing.id));
  const targets = [...new Set(listings.flatMap((listing) => bumpTargets(listing).filter((id) => !shown.has(id))))];
  // Just built: the boxes' products the index read are taken from it; only the others are paid for and read.
  const have = built ? targets.map((id) => built.read.get(id)).filter((listing): listing is Listing => Boolean(listing)) : [];
  const missing = built ? targets.filter((id) => !built.read.has(id)) : targets;
  const related = [...have, ...((await paidRead(store, missing)) ?? [])];
  // A shown match deleted since the index was kept, or no longer matching, is not counted (review of #4172, LOW).
  return { listings, related, total: found.length - (shownIds.length - listings.length) };
}
