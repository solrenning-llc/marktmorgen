/**
 * A store's saved sales filters (767 [STN14], unit 3; Claude 4, 9 November 2026): a filter of the studio's sales
 * list kept under a name, as the page's own address for it (lib/sales-filter-rules.ts has the rules).
 *
 *   nl:sales:filters:<statsId>   hash: filter id -> JSON { id, name, query }, at most MAX_SAVED_FILTERS fields
 *
 * - The cap is checked with the write, in one script (lib/saved-block-store.ts SAVE_SECTION, the same capped write
 *   of a hash the saved sections use): a new filter only while the store has room, a rename only of a filter that
 *   is still there. It bounds what is stored, the same on every plan; it is not a plan limit.
 * - Names are one per store in any case, checked against the list read just before the write: two people saving
 *   the same new name at the same instant may both keep it, and either can be renamed or deleted.
 * - A saved filter never keeps a buyer's address (the email part of a filter): it would outlive the person's
 *   deletion (lib/person-erasure.ts). The product words, the days and the kind name no one.
 * - Rule 24 (CX-123): a list answered in another shape, a key of another kind or a kept filter that is not one is
 *   UnknownReplyError, never "no saved filters"; a write or a deletion is said done only on its exact answer.
 */
import { randomBytes } from "node:crypto";
import { isRedisConfigured, redisPipeline } from "@/lib/redis";
import { UnknownReplyError, countOf, repliesFor } from "@/lib/redis-reply";
import { SAVE_SECTION } from "@/lib/saved-block-store";
import {
  MAX_SAVED_FILTERS,
  SAVED_FILTER_BYTES,
  SAVED_FILTER_ID,
  type SalesFilter,
  type SavedFilter,
  type SavedFilterRefusal,
  byName,
  filterQuery,
  isFiltered,
  parseSavedFilter,
  savedFilterName,
  utf8Bytes,
} from "@/lib/sales-filter-rules";

const filtersKey = (statsId: string) => `nl:sales:filters:${statsId}`;

export type SaveFilterResult = { ok: true; filter: SavedFilter; filters: SavedFilter[] } | { ok: false; reason: SavedFilterRefusal };

function configured(): void {
  if (!isRedisConfigured()) throw new UnknownReplyError("the saved filters (no database)");
}

/** Every saved filter of the store, by name. An empty list only when Redis said there are none. */
export async function readSavedFilters(statsId: string): Promise<SavedFilter[]> {
  configured();
  const replies = repliesFor(await redisPipeline([["HVALS", filtersKey(statsId)]]).catch(() => null), 1);
  const values = replies?.[0];
  if (!Array.isArray(values)) throw new UnknownReplyError("the saved filters");
  const filters: SavedFilter[] = [];
  for (const value of values) {
    const filter = parseSavedFilter(value);
    if (!filter) throw new UnknownReplyError("a saved filter");
    filters.push(filter);
  }
  return filters.sort(byName);
}

/** Writes one filter with the cap (new) or only while it is there (edit): "ok", "full" or "gone", else unknown. */
async function writeFilter(statsId: string, filter: SavedFilter, isNew: boolean): Promise<"ok" | "full" | "gone"> {
  const replies = repliesFor(
    await redisPipeline([["EVAL", SAVE_SECTION, 1, filtersKey(statsId), filter.id, JSON.stringify(filter), MAX_SAVED_FILTERS, isNew ? "new" : "edit"]]).catch(() => null),
    1,
  );
  // Only the script's own whole number counts: a "1", an "OK" or a [1] is not a filter kept.
  const answer = replies?.[0];
  if (answer === 1) return "ok";
  if (answer === 0) return "full";
  if (answer === -2) return "gone";
  throw new UnknownReplyError("a saved filter's write");
}

function sameName(filters: readonly SavedFilter[], name: string, except = ""): boolean {
  const lower = name.toLowerCase();
  return filters.some((f) => f.id !== except && f.name.toLowerCase() === lower);
}

/**
 * Keeps `filter` under `name`. `known` is the list the caller has just read (readSavedFilters), so the name is
 * checked against it without reading again; read here when not given.
 */
export async function saveSalesFilter(statsId: string, rawName: unknown, filter: SalesFilter, known?: SavedFilter[]): Promise<SaveFilterResult> {
  const name = savedFilterName(rawName);
  if (!name) return { ok: false, reason: "name" };
  if (filter.email) return { ok: false, reason: "email" };
  if (!isFiltered(filter)) return { ok: false, reason: "empty" };
  const saved: SavedFilter = { id: randomBytes(6).toString("hex"), name, query: filterQuery(filter) };
  if (utf8Bytes(JSON.stringify(saved)) > SAVED_FILTER_BYTES) return { ok: false, reason: "long" };
  const filters = known ?? (await readSavedFilters(statsId));
  if (sameName(filters, name)) return { ok: false, reason: "taken" };
  if (filters.length >= MAX_SAVED_FILTERS) return { ok: false, reason: "full" };
  const written = await writeFilter(statsId, saved, true);
  // A new id already there ("gone" for a new one) is a twelve-hex-digit collision: unknown, never kept.
  if (written === "gone") throw new UnknownReplyError("a saved filter's new id");
  if (written === "full") return { ok: false, reason: "full" };
  return { ok: true, filter: saved, filters: [...filters, saved].sort(byName) };
}

/** Gives a saved filter another name; its filter stays as it was. */
export async function renameSalesFilter(statsId: string, id: unknown, rawName: unknown, known?: SavedFilter[]): Promise<SaveFilterResult> {
  const name = savedFilterName(rawName);
  if (!name) return { ok: false, reason: "name" };
  const filters = known ?? (await readSavedFilters(statsId));
  const before = typeof id === "string" ? filters.find((f) => f.id === id) : undefined;
  if (!before) return { ok: false, reason: "gone" };
  if (sameName(filters, name, before.id)) return { ok: false, reason: "taken" };
  const renamed: SavedFilter = { ...before, name };
  if ((await writeFilter(statsId, renamed, false)) !== "ok") return { ok: false, reason: "gone" };
  return { ok: true, filter: renamed, filters: filters.map((f) => (f.id === renamed.id ? renamed : f)).sort(byName) };
}

/** Deletes a saved filter: true when it was there, false when it was already gone. */
export async function removeSalesFilter(statsId: string, id: unknown): Promise<boolean> {
  if (typeof id !== "string" || !SAVED_FILTER_ID.test(id)) return false;
  configured();
  const removed = countOf(repliesFor(await redisPipeline([["HDEL", filtersKey(statsId), id]]).catch(() => null), 1)?.[0]);
  // HDEL's own count, exactly: anything else is not known to be removed, nor known to be absent.
  if (removed === null || removed > 1) throw new UnknownReplyError("a saved filter's deletion");
  return removed === 1;
}
