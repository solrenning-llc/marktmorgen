import { after } from "next/server";
import { apiAdder, apiError, apiOk, apiWriter, readApiBody } from "@/lib/api-guard";
import { noticeCreator } from "@/lib/account-notice";
import { MAX_ENDPOINT_URL, addEndpoint, removeEndpoint, webhooksView } from "@/lib/webhooks";

/**
 * POST /api/v1/hooks — adds a webhook endpoint from a tool, as the studio's
 * Webhooks page does: `{ "url": "https://…", "events": ["sale.completed"] }`.
 * The answer carries its id and its signing secret, this once. This is how
 * Zapier subscribes a Zap to the store (zapier/index.js).
 * DELETE /api/v1/hooks — removes one: `{ "id": "we_…" }`.
 *
 * A key that may write only: an endpoint is where buyers' names and
 * addresses can go, so a key made to read cannot add one, and every endpoint
 * added this way is reported to the creator, as one added in the studio is
 * (lib/account-notice.ts). The same five endpoints a store may have
 * (MAX_ENDPOINTS) count both.
 */
const ADD_ERRORS: Record<"full" | "invalid" | "events" | "duplicate" | "unavailable" | "paused", number> = { full: 409, invalid: 400, events: 400, duplicate: 409, unavailable: 503, paused: 409 };

/** After the answer when there is a request to wait for; at once otherwise (a check, a script). */
function later(task: () => Promise<unknown>): void {
  const run = () => task().catch((error) => console.error("api: telling the creator of a webhook failed", error));
  try {
    after(run);
  } catch {
    void run();
  }
}

export async function POST(request: Request) {
  // 232 [CA1] unit 4c: waits while the plan's renewal is unpaid or a payment for it is disputed, before it is counted.
  const writer = await apiAdder(request);
  if (writer instanceof Response) return writer;
  const body = writer.body;
  const url = typeof body.url === "string" ? body.url.slice(0, MAX_ENDPOINT_URL + 1) : "";
  try {
    // Kept with the key that added it, so it pauses and stops with that key (owner C3-100).
    const result = await addEndpoint(writer.store, url, body.events, Date.now(), writer.keyId);
    if (!result.ok) return apiError(ADD_ERRORS[result.reason], result.reason, result.message);
    const added = result.view.endpoints[result.view.endpoints.length - 1];
    if (!added) return apiError(502, "unavailable", "The endpoint could not be read back just now. Try again in a moment.");
    later(() => noticeCreator(writer.store, { kind: "webhook-added", where: added.where }));
    return apiOk({ data: { id: added.id, where: added.where, events: added.events, secret: result.secret, added_at: added.addedAt } });
  } catch (error) {
    console.error("api: adding a webhook failed", error);
    return apiError(502, "unavailable", "The endpoint could not be added just now. Nothing was changed; try again in a moment.");
  }
}

export async function DELETE(request: Request) {
  const writer = await apiWriter(request);
  if (writer instanceof Response) return writer;
  const body = await readApiBody(request);
  if (body instanceof Response) return body;
  const id = typeof body.id === "string" ? body.id.slice(0, 40) : "";
  try {
    const before = (await webhooksView(writer.store)).endpoints.find((e) => e.id === id);
    if (!before) return apiError(404, "not_found", "No endpoint with that id on this store.");
    await removeEndpoint(writer.store, id);
    later(() => noticeCreator(writer.store, { kind: "webhook-removed", where: before.where }));
    return apiOk({ data: { id, status: "removed" } });
  } catch (error) {
    console.error("api: removing a webhook failed", error);
    return apiError(502, "unavailable", "The endpoint could not be removed just now. Try again in a moment.");
  }
}
