import { apiError, apiOk, apiStore, holdMoreApi } from "@/lib/api-guard";
import { recentDeliveries } from "@/lib/api-read";

/**
 * GET /api/v1/hooks/deliveries?endpoint=we_… — the store's recent webhook
 * deliveries, newest first, the same ones its studio's Webhooks page lists
 * (the last 50, each kept up to seven days): what each was (its event type
 * and event id, or a test), which endpoint it went to, its state, how many
 * times it was tried, the status the address last answered and, when it did
 * not go, why (378 [TB4] complement WG (b)). Never the message itself, so
 * nothing a buyer typed or their address is read out of it. `endpoint` keeps
 * only that endpoint's.
 *
 * Any key of the store. Measured first, its most set aside, then settled at
 * what it read and sent, as /api/v1/events (lib/api-read.ts,
 * recentDeliveries). A log that cannot be read is 502, never an empty list;
 * a delivery kept that cannot be read is counted in `unreadable`.
 */
export async function GET(request: Request) {
  const store = await apiStore(request);
  if (store instanceof Response) return store;
  const params = new URL(request.url).searchParams;
  const endpoint = params.get("endpoint");
  if (endpoint !== null && !/^we_[0-9a-f]{16}$/.test(endpoint)) return apiError(400, "invalid_id", "Send an endpoint's id as endpoint, such as we_0123456789abcdef, or leave it out for every endpoint's deliveries.");
  try {
    const found = await recentDeliveries(store, endpoint, (most) => holdMoreApi(store, most));
    return found instanceof Response ? found : apiOk(found);
  } catch (error) {
    console.error("api: reading webhook deliveries failed", error);
    return apiError(502, "unavailable", "The deliveries could not be read just now. Try again in a moment.");
  }
}
