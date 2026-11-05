import { apiError, apiOk, apiStore, takeMoreApi } from "@/lib/api-guard";
import { apiReadUnits, eventsWork } from "@/lib/api-read-rules";
import { WEBHOOK_EVENTS, isWebhookEvent, recentMessages } from "@/lib/webhooks";

/**
 * GET /api/v1/events?type=sale.completed&limit=3 — the store's latest
 * messages of one event, newest first, exactly as its webhooks were sent
 * them in the last week (lib/webhooks.ts, recentMessages). A tool shows them
 * as examples while the creator sets a step up; Zapier does
 * (zapier/index.js). Nothing is read that a webhook did not already carry.
 */
export async function GET(request: Request) {
  const store = await apiStore(request);
  if (store instanceof Response) return store;
  const params = new URL(request.url).searchParams;
  const type = params.get("type");
  if (!isWebhookEvent(type)) return apiError(400, "type", `Ask for one event type: ${WEBHOOK_EVENTS.join(", ")}.`);
  const limit = Number(params.get("limit") ?? 3);
  // The newest LOG_SIZE deliveries are read whatever the limit, so their most is taken first (lib/api-read-rules.ts, eventsWork).
  const refused = await takeMoreApi(store, apiReadUnits(eventsWork()));
  if (refused) return refused;
  try {
    return apiOk({ data: await recentMessages(store, type, Number.isFinite(limit) ? limit : 3) });
  } catch (error) {
    console.error("api: reading recent events failed", error);
    return apiError(502, "unavailable", "The events could not be read just now. Try again in a moment.");
  }
}
