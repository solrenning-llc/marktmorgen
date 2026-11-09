import type { NextRequest } from "next/server";
import { normaliseHandle, releaseHandle } from "@/lib/store";
import { guardStoreWrite } from "@/lib/store-request";
import { carryStops } from "@/lib/store-stop";
import { WEEKLY_OFF_SET, forgetWeeklyTeamAt } from "@/lib/stats-report";
import { HEARD_OFF_SET } from "@/lib/heard";
import { UnknownReplyError } from "@/lib/redis-reply";

const MAX_BODY_BYTES = 2_000;

/** Lets go of an address the signed-in creator's store used before. */
export async function POST(request: NextRequest) {
  // Another site, the size of the body, the session, the store the studio
  // page was drawn for, and the role's "settings" (lib/store-request.ts).
  const guarded = await guardStoreWrite(request, "settings", MAX_BODY_BYTES);
  if (!guarded.ok) return guarded.response;
  const { ref, body, store } = guarded;

  const handle = typeof body.handle === "string" ? body.handle : "";

  try {
    // A stop the creator wrote while this address was the store's (the numbers emails, the question after paying)
    // goes to the store's id first: an address let go of is never read for its stops (lib/store-stop.ts).
    await carryStops([WEEKLY_OFF_SET, HEARD_OFF_SET], store, normaliseHandle(handle));
    // A team list still under this address is never read (the store's is kept by its id or its current address):
    // it is taken out, so the next store at the address does not inherit it.
    await forgetWeeklyTeamAt(store, normaliseHandle(handle));
    const result = await releaseHandle(ref, handle);
    if (!result.ok) {
      return Response.json(
        { ok: false, error: result.reason },
        { status: result.reason === "current" ? 409 : 400 },
      );
    }
    return Response.json({ ok: true, handle });
  } catch (error) {
    if (error instanceof UnknownReplyError) {
      console.error("an address's stops or team list could not be carried to the store's id; the address was not let go", error);
      return Response.json({ ok: false, error: "not_confirmed" }, { status: 503 });
    }
    console.error("releasing an address failed", error);
    return Response.json({ ok: false, error: "server_error" }, { status: 500 });
  }
}
