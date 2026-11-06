import type { NextRequest } from "next/server";
import { guardStoreWrite } from "@/lib/store-request";
import { ensureStatsId } from "@/lib/store";
import { saveNotifyOff } from "@/lib/notify-prefs";
import { OPTIONAL_EVENTS } from "@/lib/notify-prefs-rules";

/**
 * Which studio alert emails the store's owner gets (lib/notify-prefs.ts):
 * `{ off: [...] }`, the optional events switched off, replacing the list
 * saved before; `{ off: [] }` turns every one back on. A setting, so for the
 * owner and an Admin. An always-on notice is refused with its own error, and
 * a write that could not be confirmed is said as such, never as saved.
 */
export async function POST(request: NextRequest) {
  const guarded = await guardStoreWrite(request, "settings", 1_000);
  if (!guarded.ok) return guarded.response;
  const { body, store } = guarded;
  try {
    const withStats = store.statsId ? store : await ensureStatsId(guarded.ref);
    if (!withStats?.statsId) return Response.json({ ok: false, error: "unavailable" }, { status: 503 });
    const result = await saveNotifyOff(withStats.statsId, body.off);
    if (result === "invalid" || result === "always_on") return Response.json({ ok: false, error: result }, { status: 400 });
    if (result === "unknown") return Response.json({ ok: false, error: "unknown" }, { status: 503, headers: { "Cache-Control": "no-store" } });
    return Response.json({ ok: true, off: OPTIONAL_EVENTS.filter((event) => result.has(event)) }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    console.error("saving the alert email choices failed", error);
    return Response.json({ ok: false, error: "server_error" }, { status: 500 });
  }
}
