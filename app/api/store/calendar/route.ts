import type { NextRequest } from "next/server";
import { ensureStatsId, storeForEmail } from "@/lib/store";
import { guardStoreWrite, text } from "@/lib/store-request";
import { CalendarSettingsChanged, CalendarSettingsUnconfirmed, CalendarSettingsUnreadable, MAX_FEED_URL, addFeed, newFeedToken, removeFeed } from "@/lib/calendar-sync";

/** What the studio says when the settings could not be changed safely (review of #2882): never a plain "done". */
const CALENDAR_SETTINGS_WORDS = {
  unreadable: "Your calendar settings could not be read, so nothing was changed. Try again later.",
  changed: "Your calendars were changed somewhere else at the same moment, so nothing was changed. Reload the page and try again.",
  unconfirmed: "We could not confirm that this change was saved. Reload the page to see your calendars as they are now.",
} as const;

/**
 * The creator's calendars: adds one (after reading it once), removes one, or
 * replaces the private subscription address. The answer never carries a
 * calendar's address back — only which service it is and how it went.
 */
export async function POST(request: NextRequest) {
  const guarded = await guardStoreWrite(request, "settings");
  if (!guarded.ok) return guarded.response;

  try {
    const loaded = await storeForEmail(guarded.ref);
    const store = loaded && !loaded.statsId ? await ensureStatsId(guarded.ref) : loaded;
    if (!store || !store.statsId) return Response.json({ ok: false, error: "none" }, { status: 400 });

    const action = text(guarded.body.action, 20);
    if (action === "add") {
      const result = await addFeed(store, text(guarded.body.url, MAX_FEED_URL + 1));
      if (!result.ok) return Response.json({ ok: false, error: result.reason, message: result.message }, { status: result.reason === "unavailable" ? 503 : 400 });
      return Response.json({ ok: true, view: result.view, busyTimes: result.busyTimes });
    }
    if (action === "remove") {
      return Response.json({ ok: true, view: await removeFeed(store, text(guarded.body.id, 40)) });
    }
    if (action === "rotate") {
      return Response.json({ ok: true, view: await newFeedToken(store) });
    }
    return Response.json({ ok: false, error: "invalid" }, { status: 400 });
  } catch (error) {
    if (error instanceof CalendarSettingsUnreadable) return Response.json({ ok: false, error: "unreadable", message: CALENDAR_SETTINGS_WORDS.unreadable }, { status: 503 });
    if (error instanceof CalendarSettingsChanged) return Response.json({ ok: false, error: "changed", message: CALENDAR_SETTINGS_WORDS.changed }, { status: 409 });
    if (error instanceof CalendarSettingsUnconfirmed) return Response.json({ ok: false, error: "unconfirmed", message: CALENDAR_SETTINGS_WORDS.unconfirmed }, { status: 503 });
    console.error("changing calendars failed", error);
    return Response.json({ ok: false, error: "server_error" }, { status: 500 });
  }
}
