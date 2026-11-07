import type { NextRequest } from "next/server";
import { guardStoreWrite } from "@/lib/store-request";
import { setAlertEmailsOff } from "@/lib/store";
import { setWeeklyOff } from "@/lib/stats-report";

const NO_STORE = { "Cache-Control": "no-store" };

/**
 * Which optional alert emails the store's owner gets (alertEmailsOff in the
 * store record, lib/notify-prefs-rules.ts):
 *
 *   `{ off: [...] }`       the events switched off, replacing the list saved
 *                          before; `{ off: [] }` turns every one back on;
 *   `{ restart: true }`    undoes the weekly email's stop link, which stops
 *                          these and the weekly, monthly and busy-day emails
 *                          (lib/stats-report.ts setWeeklyOff, the same as its
 *                          own "Start it again" button).
 *
 * The owner's only (app/studio/notifications/page.tsx says why): the request
 * needs the settings permission and then the owner's role. An always-on
 * notice is refused with its own error, so the page can say why.
 */
export async function POST(request: NextRequest) {
  const guarded = await guardStoreWrite(request, "settings", 1_000);
  if (!guarded.ok) return guarded.response;
  if (guarded.role !== "owner") return Response.json({ ok: false, error: "owner_only" }, { status: 403, headers: NO_STORE });
  try {
    if (guarded.body.restart === true) {
      await setWeeklyOff(guarded.store.handle, false);
      return Response.json({ ok: true, restarted: true }, { headers: NO_STORE });
    }
    const result = await setAlertEmailsOff(guarded.ref, guarded.body.off);
    if (!result.ok) return Response.json({ ok: false, error: result.reason }, { status: 400, headers: NO_STORE });
    return Response.json({ ok: true, off: result.store.alertEmailsOff }, { headers: NO_STORE });
  } catch (error) {
    console.error("saving the alert email choices failed", error);
    return Response.json({ ok: false, error: "server_error" }, { status: 500, headers: NO_STORE });
  }
}
