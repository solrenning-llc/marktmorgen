import type { NextRequest } from "next/server";
import { renameHandle } from "@/lib/store";
import { guardStoreWrite } from "@/lib/store-request";
import { keepWeeklyTeamById } from "@/lib/stats-report";
import { UnknownReplyError } from "@/lib/redis-reply";

const MAX_BODY_BYTES = 2_000;

/** Moves the signed-in creator's store to a new address. */
export async function POST(request: NextRequest) {
  // Another site, the size of the body, the session, the store the studio
  // page was drawn for, and the role's "settings" (lib/store-request.ts).
  const guarded = await guardStoreWrite(request, "settings", MAX_BODY_BYTES);
  if (!guarded.ok) return guarded.response;
  const { ref, body, store } = guarded;

  const handle = typeof body.handle === "string" ? body.handle : "";

  try {
    // Who on the team gets the weekly email, if still kept under the current address, goes to the store's id
    // before the address changes, so the rename loses nobody (lib/stats-report.ts, keepWeeklyTeamById).
    await keepWeeklyTeamById(store);
    const result = await renameHandle(ref, handle);
    if (!result.ok) {
      return Response.json(
        { ok: false, error: result.reason, limit: result.limit },
        { status: result.reason === "too_many" ? 409 : 400 },
      );
    }
    return Response.json({ ok: true, handle: result.store.handle });
  } catch (error) {
    if (error instanceof UnknownReplyError) {
      console.error("the team list could not be kept by the store's id; the address was not changed", error);
      return Response.json({ ok: false, error: "not_confirmed" }, { status: 503 });
    }
    console.error("changing an address failed", error);
    return Response.json({ ok: false, error: "server_error" }, { status: 500 });
  }
}
