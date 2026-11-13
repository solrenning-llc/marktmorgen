import type { NextRequest } from "next/server";
import { idsOfKind } from "@/lib/catalog";
import { savePaths } from "@/lib/learning-paths";
import { PATHS_BODY_BYTES, pathsRefusal } from "@/lib/learning-paths-studio";
import { guardStoreWrite } from "@/lib/store-request";

/**
 * Saves a store's learning paths, all at once (249 [ST2], unit 3):
 * POST `{ paths: [{ id?, name, courses, order }] }` from the studio's editor
 * (components/learning-paths-editor.tsx). Every path is checked against the
 * store's own courses (the course products its record lists, so nothing more
 * is read for them) and the list is refused as a whole, saying which path and
 * why, rather than cut down. Nothing is said as saved unless it was kept
 * exactly (lib/learning-paths.ts savePaths); a kept list that does not read is
 * never written over. The same permission as changing products.
 */

const NO_STORE = { "Cache-Control": "private, no-store" };

export async function POST(request: NextRequest) {
  const guarded = await guardStoreWrite(request, "products", PATHS_BODY_BYTES);
  if (!guarded.ok) return guarded.response;
  const { body, store } = guarded;
  if (!store.statsId) return Response.json({ ok: false, error: "unknown" }, { status: 503, headers: { ...NO_STORE, "Retry-After": "5" } });
  const result = await savePaths({ ...store, statsId: store.statsId }, body.paths, new Set(idsOfKind(store, "course")));
  switch (result.state) {
    case "saved":
      return Response.json({ ok: true, paths: result.paths }, { headers: NO_STORE });
    case "refused":
      return Response.json({ ok: false, error: "refused", problem: result.problem, index: result.index, message: pathsRefusal(result.problem, result.index) }, { status: 400, headers: NO_STORE });
    case "full":
      return Response.json({ ok: false, error: "data_full", message: result.message }, { status: 409, headers: NO_STORE });
    case "busy":
      return Response.json({ ok: false, error: "busy" }, { status: 409, headers: NO_STORE });
    default:
      return Response.json({ ok: false, error: "unknown" }, { status: 503, headers: { ...NO_STORE, "Retry-After": "5" } });
  }
}
