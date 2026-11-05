import type { NextRequest } from "next/server";
import { setVisitUs } from "@/lib/store";
import { guardStoreWrite } from "@/lib/store-request";

/**
 * Saves the "Visit us" block of the store page (lib/visit-us.ts, 521 [LB2]):
 * `{ place, hours, phone }`, each as typed; all empty takes it away. Part of
 * what the page says, so it needs the "page" permission. A part that cannot
 * be kept is named, and nothing is saved.
 */
export async function POST(request: NextRequest) {
  const guarded = await guardStoreWrite(request, "page", 2_000);
  if (!guarded.ok) return guarded.response;
  try {
    const { place, hours, phone } = guarded.body as { place?: unknown; hours?: unknown; phone?: unknown };
    const result = await setVisitUs(guarded.ref, { place, hours, phone });
    if (!result.ok) return Response.json({ ok: false, error: result.reason }, { status: result.reason === "none" ? 404 : 400 });
    return Response.json({ ok: true, visitUs: result.store.visitUs });
  } catch (error) {
    console.error("saving a store's Visit us block failed", error);
    return Response.json({ ok: false, error: "server_error" }, { status: 500 });
  }
}
