import type { NextRequest } from "next/server";
import { guardStoreWrite } from "@/lib/store-request";
import { setAlertEmailsOff } from "@/lib/store";

const NO_STORE = { "Cache-Control": "no-store" };

/**
 * Which optional alert emails the store's owner gets (alertEmailsOff in the
 * store record, lib/notify-prefs-rules.ts): `{ off: [...] }`, the events
 * switched off, replacing the list saved before; `{ off: [] }` turns every one
 * back on. A setting, so for the owner and an Admin. An always-on notice is
 * refused with its own error, so the page can say why.
 */
export async function POST(request: NextRequest) {
  const guarded = await guardStoreWrite(request, "settings", 1_000);
  if (!guarded.ok) return guarded.response;
  try {
    const result = await setAlertEmailsOff(guarded.ref, guarded.body.off);
    if (!result.ok) return Response.json({ ok: false, error: result.reason }, { status: 400, headers: NO_STORE });
    return Response.json({ ok: true, off: result.store.alertEmailsOff }, { headers: NO_STORE });
  } catch (error) {
    console.error("saving the alert email choices failed", error);
    return Response.json({ ok: false, error: "server_error" }, { status: 500, headers: NO_STORE });
  }
}
