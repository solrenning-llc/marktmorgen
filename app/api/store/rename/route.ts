import type { NextRequest } from "next/server";
import { renameHandle } from "@/lib/store";
import { guardStoreWrite } from "@/lib/store-request";

const MAX_BODY_BYTES = 2_000;

/** Moves the signed-in creator's store to a new address. */
export async function POST(request: NextRequest) {
  // Another site, the size of the body, the session, the store the studio
  // page was drawn for, and the role's "settings" (lib/store-request.ts).
  const guarded = await guardStoreWrite(request, "settings", MAX_BODY_BYTES);
  if (!guarded.ok) return guarded.response;
  const { ref, body } = guarded;

  const handle = typeof body.handle === "string" ? body.handle : "";

  try {
    const result = await renameHandle(ref, handle);
    if (!result.ok) {
      return Response.json(
        { ok: false, error: result.reason, limit: result.limit },
        { status: result.reason === "too_many" ? 409 : 400 },
      );
    }
    // The store's own domain not known to have followed: said, so the studio can name the step that moves it.
    return Response.json(result.domainBehind ? { ok: true, handle: result.store.handle, domainBehind: true } : { ok: true, handle: result.store.handle });
  } catch (error) {
    console.error("changing an address failed", error);
    return Response.json({ ok: false, error: "server_error" }, { status: 500 });
  }
}
