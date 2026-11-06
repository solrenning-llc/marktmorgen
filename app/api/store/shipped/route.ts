import type { NextRequest } from "next/server";
import { guardStoreWrite, text } from "@/lib/store-request";
import { markShipped } from "@/lib/shipments";
import { jsonAccess } from "@/lib/studio-route";
import { shipmentMailStatus } from "@/lib/shipment-mail-outbox";

export async function GET(request: NextRequest) {
  const access = await jsonAccess(request, "orders");
  if (access instanceof Response) return access;
  const mail = await shipmentMailStatus(access.store.statsId, request.nextUrl.searchParams.get("session") ?? "");
  return Response.json(mail ? { ok: true, mail } : { ok: false, error: "unknown" }, {
    status: mail ? 200 : 503, headers: { "Cache-Control": "no-store" },
  });
}

/**
 * Marks a shipped order as sent and emails its buyer once (lib/shipments.ts):
 * `{ session, tracking }`, the tracking link optional. Who may is who may see
 * and handle the store's orders.
 */
export async function POST(request: NextRequest) {
  const guarded = await guardStoreWrite(request, "orders", 2_000);
  if (!guarded.ok) return guarded.response;
  const { body, store } = guarded;
  const done = await markShipped(store, text(body.session, 220), body.tracking);
  if (!done.ok) return Response.json({ ok: false, error: done.reason }, { status: done.reason === "stripe" ? 502 : done.reason === "mail_unavailable" ? 503 : 400 });
  return Response.json({ ok: true, shipped: done.shipped, emailed: done.emailed, mail: done.mail });
}
