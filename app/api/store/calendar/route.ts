import type { NextRequest } from "next/server";
import { ensureStatsId, storeForEmail } from "@/lib/store";
import { guardStoreWrite, text } from "@/lib/store-request";
import { MAX_FEED_URL, addFeed, newFeedToken, removeFeed } from "@/lib/calendar-sync";
import { CALENDAR_ADDS_PER_CONNECTION_TEN_MINUTES, CALENDAR_ADDS_PER_TEN_MINUTES } from "@/lib/calendar-limits";
import { clientAddress, essentialLimitState } from "@/lib/request-guard";

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
      // Each add reads a remote calendar: counted per connection, then per store, before any read (R27).
      // "busy" when a count is not known, never "slow"; removing or a new address reads nothing remote.
      const statsId = store.statsId;
      for (const check of [
        () => essentialLimitState("calendar-add-ip", clientAddress(request), CALENDAR_ADDS_PER_CONNECTION_TEN_MINUTES, 600),
        () => essentialLimitState("calendar-add", statsId, CALENDAR_ADDS_PER_TEN_MINUTES, 600),
      ]) {
        const state = await check();
        if (state === "unknown") return Response.json({ ok: false, error: "busy" }, { status: 503 });
        if (state === "exceeded") return Response.json({ ok: false, error: "slow" }, { status: 429 });
      }
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
    console.error("changing calendars failed", error);
    return Response.json({ ok: false, error: "server_error" }, { status: 500 });
  }
}
