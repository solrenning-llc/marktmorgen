import { apiError, apiOk, apiStore, holdMoreApi } from "@/lib/api-guard";
import { recentEvents } from "@/lib/api-read";
import { WEBHOOK_EVENTS, isWebhookEvent } from "@/lib/webhooks";

/**
 * GET /api/v1/events?type=sale.completed&limit=3 — the store's latest
 * messages of one event, newest first, exactly as its webhooks were sent
 * them in the last week (lib/webhooks.ts, recentMessagesOf). A tool shows
 * them as examples while the creator sets a step up; Zapier does
 * (zapier/index.js). Nothing is read that a webhook did not already carry.
 */
export async function GET(request: Request) {
  const store = await apiStore(request);
  if (store instanceof Response) return store;
  const params = new URL(request.url).searchParams;
  const type = params.get("type");
  if (!isWebhookEvent(type)) return apiError(400, "type", `Ask for one event type: ${WEBHOOK_EVENTS.join(", ")}.`);
  const limit = Number(params.get("limit") ?? 3);
  try {
    // The deliveries are measured first, their bytes and what can be sent of them set aside, then settled at what
    // was read and sent (lib/api-read.ts, recentEvents; lib/api-read-rules.ts, eventsWork).
    const found = await recentEvents(store, type, limit, (most) => holdMoreApi(store, most));
    return found instanceof Response ? found : apiOk({ data: found });
  } catch (error) {
    console.error("api: reading recent events failed", error);
    return apiError(502, "unavailable", "The events could not be read just now. Try again in a moment.");
  }
}
