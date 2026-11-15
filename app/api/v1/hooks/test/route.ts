import { apiAdder, apiError, apiOk } from "@/lib/api-guard";
import { sendTest } from "@/lib/webhooks";

/**
 * POST /api/v1/hooks/test — sends one test message to one of the store's
 * webhook endpoints, now, as the studio's "Send test" does: `{ "id": "we_…" }`
 * (378 [TB4] complement WG (b)). The answer says how it went: whether the
 * address took it, the status it answered (0 when it did not answer) and,
 * when it failed, why.
 *
 * A key that may write only, waiting while the plan's renewal is unpaid or a
 * payment for it is disputed (apiAdder, as the studio pauses its test). The
 * same sendTest as the studio's (lib/webhooks.ts): ten tests a minute for the
 * store, one of the store's webhook deliveries for the month taken before the
 * message is sent (refused, nothing is sent), tried once, never retried, and
 * listed with the store's deliveries. The delivery log is not read back for
 * this answer, which never sends it.
 */
export async function POST(request: Request) {
  const writer = await apiAdder(request);
  if (writer instanceof Response) return writer;
  const id = typeof writer.body.id === "string" ? writer.body.id.slice(0, 40) : "";
  if (!/^we_[0-9a-f]{16}$/.test(id)) return apiError(400, "invalid_id", "Send the endpoint's id as id, such as we_0123456789abcdef, as adding it answered.");
  try {
    const result = await sendTest(writer.store, id, Date.now(), { via: "api", view: false });
    if (!result.ok) {
      if (result.reason === "missing") return apiError(404, "not_found", "No endpoint with that id on this store.");
      if (result.reason === "limited") return apiError(429, "rate_limited", "At most ten test messages a minute for a store. Try again in a minute; nothing was sent.");
      if (result.reason === "used") return apiError(429, "monthly_limit", result.message);
      // The key that added the endpoint is paused or revoked (owner C3-100): nothing was counted or sent.
      if (result.reason === "held") return apiError(409, "held", result.message);
      return apiError(503, "unavailable", "The test could not be sent just now. Nothing was sent; try again in a moment.");
    }
    const d = result.delivery;
    // A tried test is delivered or failed; any other state is not one this answer can say, so it is not said as either.
    if (d.state !== "delivered" && d.state !== "failed") return apiError(502, "unavailable", "Whether the test reached the address could not be confirmed. Check the store's Webhooks page in the studio before trying again.");
    return apiOk({
      data: {
        delivery: d.id,
        endpoint: id,
        type: "test",
        delivered: d.state === "delivered",
        status: d.lastStatus,
        error: d.state === "delivered" ? null : d.lastError || null,
        sent_at: new Date(d.lastAt || d.createdAt).toISOString(),
      },
    });
  } catch (error) {
    console.error("api: sending a webhook test failed", error);
    return apiError(502, "unavailable", "Whether the test was sent could not be confirmed. Check the store's Webhooks page in the studio before trying again.");
  }
}
