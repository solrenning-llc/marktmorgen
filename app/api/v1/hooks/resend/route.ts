import { apiAdder, apiError, apiOk, takeMoreApi } from "@/lib/api-guard";
import { RESEND_WORK, apiReadUnits } from "@/lib/api-read-rules";
import { readRange, resendRange } from "@/lib/api-hook-resend";
import { resendDelivery } from "@/lib/webhooks";

/** What each refusal of resendDelivery is through the API: its status, its code and, where it has none of its own, its sentence. */
const REFUSED = {
  missing: [404, "not_found", "No delivery with that id that can be sent again on this store: it may be a test, kept no longer, or about somebody deleted from your store."],
  not_failed: [409, "not_failed", "Only a delivery that failed for good can be sent again. One delivered is never sent twice, and one still being tried is tried on its own."],
  not_heard: [409, "not_heard", "Its endpoint no longer listens for this kind of event, so it is not sent it."],
  resent: [409, "resent", "This delivery was already sent again, and that copy was delivered or is still being tried, or it is itself a copy sent again."],
  limited: [429, "rate_limited", "At most ten tests and deliveries sent again a minute for a store. Try again in a minute; nothing was sent."],
  unavailable: [503, "unavailable", "It could not be sent again just now. Nothing was sent; try again in a moment."],
} as const;

/**
 * POST /api/v1/hooks/resend — sends one failed delivery again, once, now, as
 * the studio's "Send again" does: `{ "delivery": "dlv_…" }` (378 [TB4]
 * complement WG (b)). The same message with the same event id, so a receiver
 * that already took it drops the repeat, signed afresh; a new line in the log
 * that names the one it sends again, tried once and never put back on the
 * schedule (lib/webhooks.ts, resendDelivery).
 *
 * A key that may write only, waiting while the plan's renewal is unpaid or a
 * payment for it is disputed (apiAdder). What it reads, at its most
 * (RESEND_WORK), is taken from the store's API requests before anything is
 * read; the try is one of the store's webhook deliveries for the month, taken
 * before the endpoint is called (refused, nothing is sent), and shares the
 * tests' ten a minute. The delivery log is not read back for this answer.
 *
 * `{ "endpoint": "we_…", "from": "…", "to": "…" }` sends that endpoint's
 * deliveries that failed for good in the interval again instead, oldest
 * first, at most ten, each the same way (lib/api-hook-resend.ts, resendRange).
 */
export async function POST(request: Request) {
  const writer = await apiAdder(request);
  if (writer instanceof Response) return writer;
  // An endpoint's failed deliveries of an interval (lib/api-hook-resend.ts), instead of one by id.
  if (writer.body.endpoint !== undefined) {
    if (writer.body.delivery !== undefined) return apiError(400, "invalid_request", "Send either delivery, for one, or endpoint with from and to, for an interval; not both.");
    const ask = readRange(writer.body);
    if ("error" in ask) return apiError(400, ask.error, ask.message);
    try {
      const done = await resendRange(writer.store, ask);
      if (done === "no_endpoint") return apiError(404, "not_found", "No endpoint with that id on this store.");
      return done instanceof Response ? done : apiOk({ data: done });
    } catch (error) {
      console.error("api: sending webhook deliveries again failed", error);
      return apiError(502, "unavailable", "Whether the deliveries were sent again could not be confirmed. Check the store's Webhooks page in the studio, or read GET /api/v1/hooks/deliveries, before trying again.");
    }
  }
  const id = typeof writer.body.delivery === "string" ? writer.body.delivery.slice(0, 40) : "";
  if (!/^dlv_[0-9a-f]{24}$/.test(id)) return apiError(400, "invalid_id", "Send the delivery's id as delivery, such as dlv_0123456789abcdef01234567, as GET /api/v1/hooks/deliveries lists it.");
  // Its reads at their most, before any of them.
  const refused = await takeMoreApi(writer.store, apiReadUnits(RESEND_WORK));
  if (refused) return refused;
  try {
    const result = await resendDelivery(writer.store, id, Date.now(), { view: false });
    if (!result.ok) {
      if (result.reason === "used") return apiError(429, "monthly_limit", result.message);
      // Paused: the plan's costs, or the key that added the endpoint (owner C3-100). Nothing was counted or sent.
      if (result.reason === "paused") return apiError(409, "paused", result.message);
      if (result.reason === "too_large") return apiError(409, "too_large", result.message);
      const [status, code, message] = REFUSED[result.reason];
      return apiError(status, code, message);
    }
    const d = result.delivery;
    // A try by hand is delivered or failed; any other state is not one this answer can say, so it is not said as either.
    if (d.state !== "delivered" && d.state !== "failed") return apiError(502, "unavailable", "Whether it reached the address could not be confirmed. Check the store's Webhooks page in the studio before trying again.");
    return apiOk({
      data: {
        delivery: d.id,
        resent_from: id,
        endpoint: d.endpoint,
        type: d.type,
        event: d.eventId,
        delivered: d.state === "delivered",
        status: d.lastStatus,
        error: d.state === "delivered" ? null : d.lastError || null,
        sent_at: new Date(d.lastAt || d.createdAt).toISOString(),
      },
    });
  } catch (error) {
    console.error("api: sending a webhook delivery again failed", error);
    return apiError(502, "unavailable", "Whether it was sent again could not be confirmed. Check the store's Webhooks page in the studio before trying again.");
  }
}
