import type { NextRequest } from "next/server";
import { guardStoreWrite, text } from "@/lib/store-request";
import { jsonAccess } from "@/lib/studio-route";
import { MAX_SAVED_FILTERS, SAVED_FILTER_REFUSALS, type SavedFilterRefusal, filterFromQuery } from "@/lib/sales-filter-rules";
import { readSavedFilters, removeSalesFilter, renameSalesFilter, saveSalesFilter } from "@/lib/sales-filters";

/**
 * The store's saved sales filters (767 [STN14], unit 3; lib/sales-filters.ts). The same people who may read the
 * orders (lib/team-roles.ts "orders": the owner, admins and support) list and keep them: a saved filter is a view
 * of the sales list, and the list is theirs to see. Each request is one of the studio's (lib/studio-route.ts).
 *
 * A list that could not be read is said so (503), never answered as none; saves and renames then write nothing.
 * Deletion by validated id does not parse the kept value first, so a damaged entry can still be removed.
 */
const headers = { "Cache-Control": "private, no-store" };
const unavailable = () => Response.json({ ok: false, error: "unavailable", message: SAVED_FILTER_REFUSALS.unavailable }, { status: 503, headers });
const refuse = (reason: SavedFilterRefusal) =>
  Response.json({ ok: false, error: reason, message: SAVED_FILTER_REFUSALS[reason] }, { status: reason === "gone" ? 404 : 400, headers });

export async function GET(request: NextRequest) {
  const access = await jsonAccess(request, "orders");
  if (access instanceof Response) return access;
  const statsId = access.store.statsId;
  if (!statsId) return unavailable();
  try {
    return Response.json({ ok: true, filters: await readSavedFilters(statsId), most: MAX_SAVED_FILTERS }, { headers });
  } catch (error) {
    console.error("reading the saved sales filters failed", error);
    return unavailable();
  }
}

/**
 *   { action: "save", name, query }     a filter kept under a name; `query` is the page's address for it
 *   { action: "rename", id, name }      another name, the same filter
 *   { action: "remove", id }            deleted
 *
 * Each answers with the store's saved filters after it.
 */
export async function POST(request: NextRequest) {
  const guarded = await guardStoreWrite(request, "orders");
  if (!guarded.ok) return guarded.response;
  const { store, body } = guarded;
  const statsId = store.statsId;
  if (!statsId) return unavailable();
  const action = text(body.action, 10);
  if (action !== "save" && action !== "rename" && action !== "remove") return Response.json({ ok: false, error: "unknown" }, { status: 400, headers });
  try {
    if (action === "remove") {
      const id = text(body.id, 20);
      const removed = await removeSalesFilter(statsId, id);
      try {
        return Response.json({ ok: true, removed, filters: await readSavedFilters(statsId) }, { headers });
      } catch (error) {
        // The exact deletion already succeeded. Do not turn that truth into a false failure when another kept
        // entry is unreadable; omit the list so the caller cannot mistake it for a confirmed empty list.
        console.error("reading the saved sales filters after removal failed", error);
        return Response.json({ ok: true, removed }, { headers });
      }
    }
    // Never overwrite an unreadable list when saving or renaming.
    const filters = await readSavedFilters(statsId);
    const query = typeof body.query === "string" ? body.query : "";
    // Never cut: an address cut short would keep another filter than the one shown.
    if (action === "save" && query.length > 2_000) return refuse("long");
    const result =
      action === "save"
        ? await saveSalesFilter(statsId, body.name, filterFromQuery(query), filters)
        : await renameSalesFilter(statsId, text(body.id, 20), body.name, filters);
    if (!result.ok) return refuse(result.reason);
    return Response.json({ ok: true, filter: result.filter, filters: result.filters }, { headers });
  } catch (error) {
    console.error("changing the saved sales filters failed", error);
    return unavailable();
  }
}
