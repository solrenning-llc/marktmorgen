import type { NextRequest } from "next/server";
import { guardStoreWrite } from "@/lib/store-request";
import { setAlertEmailsOff } from "@/lib/store";
import { setWeeklyOff, weeklyStopState } from "@/lib/stats-report";
import { UnknownReplyError } from "@/lib/redis-reply";

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
 *                          own "Start it again" button). Said as done only
 *                          when the stop link, read back exactly
 *                          (weeklyStopState), no longer holds; still holding,
 *                          503 "not_changed" (the page says "Not changed
 *                          yet"); not read back, 503 "unconfirmed" (the page
 *                          says "We could not confirm…"), since the change
 *                          may have been made. A lost or unknown SREM reply
 *                          is read back the same way.
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
      try {
        await setWeeklyOff(guarded.store.handle, false);
      } catch (error) {
        // Either way the SREM may or may not have reached Redis, so the stop link is read back below, never guessed.
        // setWeeklyOff does not read its SREM's reply today, so UnknownReplyError is not thrown yet; this branch is kept
        // for when it checks that reply (r24), and only tells the log which of the two happened.
        if (error instanceof UnknownReplyError) console.error("starting the weekly emails again: Redis answered in an unknown shape", error);
        else console.error("starting the weekly emails again: the SREM's reply was lost", error);
      }
      // Whatever the SREM answered, the emails are said started again only when the stop link, read back, no longer holds;
      // still there, they were not; not read back, the change may have been made and is said as unconfirmed.
      const state = await weeklyStopState(guarded.store.handle);
      if (state === false) return Response.json({ ok: true, restarted: true }, { headers: NO_STORE });
      return Response.json({ ok: false, error: state === true ? "not_changed" : "unconfirmed" }, { status: 503, headers: NO_STORE });
    }
    const result = await setAlertEmailsOff(guarded.ref, guarded.body.off);
    if (!result.ok) return Response.json({ ok: false, error: result.reason }, { status: 400, headers: NO_STORE });
    return Response.json({ ok: true, off: result.store.alertEmailsOff }, { headers: NO_STORE });
  } catch (error) {
    console.error("saving the alert email choices failed", error);
    return Response.json({ ok: false, error: "server_error" }, { status: 500, headers: NO_STORE });
  }
}
