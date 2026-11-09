import type { NextRequest } from "next/server";
import { guardStoreWrite } from "@/lib/store-request";
import { CHECK_IN_BODY_BYTES, checkInAtDoor } from "@/lib/ticket-door";

/**
 * Checks one ticket in at the door of an in-person event: 36 [F5], unit 2.
 * POST `{ event, code }`: `event` is one of this store's events
 * (lib/ticket-door.ts), `code` the ticket's code as typed. Admits a code once
 * (lib/ticket-code.ts, checkIn) and answers `outcome`: "admitted", "used",
 * "invalid", "expired", or "unknown" (could not check, 503: nobody is let in
 * on it). The same permission as reading orders ("orders"), so support at the
 * door can do it; each check-in is one of the store's studio requests
 * (lib/studio-route.ts, studioAccess). It sells nothing and charges nothing.
 */

const NO_STORE = { "Cache-Control": "private, no-store" };

export async function POST(request: NextRequest) {
  const guarded = await guardStoreWrite(request, "orders", CHECK_IN_BODY_BYTES);
  if (!guarded.ok) return guarded.response;
  const { body, store } = guarded;
  const reply = await checkInAtDoor(store, body.event, body.code);
  return Response.json(reply.body, { status: reply.status, headers: NO_STORE });
}
