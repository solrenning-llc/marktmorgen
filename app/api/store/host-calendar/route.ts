import { serviceRefusedJson, withinServiceWhy } from "@/lib/metered-limits";
import type { NextRequest } from "next/server";
import { ensureStatsId } from "@/lib/store";
import { guardStoreWrite, text } from "@/lib/store-request";
import {
  MAX_ICS_URL,
  addHostIcs,
  disconnectHostGoogle,
  hostCalendarView,
  checkHostCalendar,
  removeHostIcs,
  setHostCalendars,
  setHostSource,
} from "@/lib/host-calendar";
import { isTimeZone } from "@/lib/call-setup";
import { TOOLS_PAUSED_WORDS, integrationPauseWord } from "@/lib/integration-pause";

/** Changes one person may make to their own calendar here in ten minutes: several reach Google or a calendar. */
const PER_TEN_MINUTES = 30;

/**
 * A team host's own calendar on this store (lib/host-calendar.ts), changed by
 * that person only: whoever is signed in, as the store's owner or on its
 * team ("member"). `{ action, ... }`:
 *
 *   source       { source: "google" | "ics" | "none" }  where busy times come from
 *   calendars    { read: string[], write: string }       which Google calendars are read, and written to
 *   ics-add      { url, tz }                              adds a private iCal address, after reading it once
 *   ics-remove                                            forgets it
 *   disconnect                                            gives Google Calendar access back and forgets it
 *   check        { tz }                                   reads the calendar again now
 *
 * Answers with the page's view, never with a calendar's address.
 */
export async function POST(request: NextRequest) {
  const guarded = await guardStoreWrite(request, "member", 4_000);
  if (!guarded.ok) return guarded.response;
  const { email, body } = guarded;
  const store = guarded.store.statsId ? guarded.store : ((await ensureStatsId(guarded.ref)) ?? guarded.store);
  if (!store.statsId) return Response.json({ ok: false, error: "none" }, { status: 400 });
  const action = text(body.action, 20);
  // member admission already enforces the existing authenticated daily bound.
  // Removing access must not depend on the monthly figure for new service work.
  const removing = action === "disconnect" || action === "ics-remove";
  // 232 [CA1] 4b4a: while the plan's costs are paused, nothing here reaches Google or a
  // calendar address for the host; taking something away (and choosing no source) stays open.
  const paused = integrationPauseWord(store);
  const reaches = action === "check" || action === "calendars" || action === "ics-add" || (action === "source" && (body.source === "google" || body.source === "ics"));
  if (paused && reaches) return Response.json({ ok: false, error: paused, message: TOOLS_PAUSED_WORDS[paused] }, { status: 409 });
  const refused = removing ? null : await withinServiceWhy("host-calendar", `${store.statsId}|${email}`, PER_TEN_MINUTES, 600, store);
  if (refused) return serviceRefusedJson(refused, "limited");
  const tz = isTimeZone(body.tz) ? (body.tz as string) : "UTC";
  const view = () => hostCalendarView(store, email, tz);
  try {
    switch (action) {
      case "source": {
        const source = body.source === "google" || body.source === "ics" ? body.source : "none";
        const problem = await setHostSource(store, email, source);
        if (problem) return Response.json({ ok: false, error: problem }, { status: problem === "unavailable" ? 503 : 400 });
        return Response.json({ ok: true, view: await view() });
      }
      case "calendars": {
        const read = Array.isArray(body.read) ? body.read.filter((id): id is string => typeof id === "string").slice(0, 20) : [];
        const problem = await setHostCalendars(store, email, read, text(body.write, 300));
        if (problem) return Response.json({ ok: false, error: problem }, { status: problem === "unavailable" ? 503 : 400 });
        return Response.json({ ok: true, view: await view() });
      }
      case "ics-add": {
        const added = await addHostIcs(store, email, text(body.url, MAX_ICS_URL + 1), tz);
        if (!added.ok) return Response.json({ ok: false, error: "ics", message: added.message }, { status: 400 });
        return Response.json({ ok: true, view: await view() });
      }
      case "ics-remove":
        await removeHostIcs(store, email);
        return Response.json({ ok: true, view: await view() });
      case "disconnect": {
        // False when Google did not confirm it took the access back: the page says so, and how to remove it there.
        const removed = await disconnectHostGoogle(store, email);
        return Response.json({ ok: true, view: await view(), ...(removed === false ? { providerAccessRemoved: false } : {}) });
      }
      case "check":
        if (!(await checkHostCalendar(store, email, tz))) return Response.json({ ok: false, error: "unavailable" }, { status: 503 });
        return Response.json({ ok: true, view: await view() });
      default:
        return Response.json({ ok: false, error: "invalid" }, { status: 400 });
    }
  } catch (error) {
    console.error("changing a host's calendar failed", error);
    return Response.json({ ok: false, error: "server_error" }, { status: 500 });
  }
}
