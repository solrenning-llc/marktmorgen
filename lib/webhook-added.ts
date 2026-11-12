import { checkUrl } from "@/lib/safe-fetch";
import { shortAddress } from "@/lib/webhook-limits";
import type { EndpointView, WebhooksView } from "@/lib/webhooks";

/**
 * Which endpoint an add created (R34). lib/webhooks.ts addEndpoint answers
 * with a view read again after its write, not with the endpoint it wrote, so
 * another endpoint added at the same moment can be last in that view. The
 * routes that add one (app/api/v1/hooks, app/api/store/webhooks) find their
 * own here instead of taking the last one in the list.
 */

/**
 * The address shown for the endpoint added from this URL, made the way
 * addEndpoint stores it (checkUrl) and the view shows it (shortAddress), so
 * the creator's notice names the endpoint really added. Null when it is not
 * an address addEndpoint takes.
 */
export function addedEndpointWhere(rawUrl: string): string | null {
  try {
    return shortAddress(checkUrl(rawUrl).toString());
  } catch {
    return null;
  }
}

/**
 * The endpoint just added, found in the view read after the write: the one
 * endpoint at that address added at that moment. None, or more than one, is
 * unknown (null), never a guess: another endpoint's id would let a tool remove
 * the wrong endpoint and leave its own receiving buyers' details.
 */
export function endpointJustAdded(view: WebhooksView, where: string, addedAt: number): EndpointView | null {
  const at = new Date(addedAt).toISOString();
  const found = view.endpoints.filter((e) => e.where === where && e.addedAt === at);
  return found.length === 1 ? found[0]! : null;
}
