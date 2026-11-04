import { type NextRequest, after } from "next/server";
import { noticeCreator } from "@/lib/account-notice";
import { ensureStatsId, storeForEmail } from "@/lib/store";
import { guardStoreWrite, text } from "@/lib/store-request";
import { WEBHOOK_TEST_PAUSED_WORDS, integrationPauseWord } from "@/lib/integration-pause";
import { MAX_ENDPOINT_URL, addEndpoint, removeEndpoint, resendDelivery, rotateSecret, sendTest, setEndpointEvents, webhooksView } from "@/lib/webhooks";

/**
 * The creator's webhook endpoints: add one (its signing secret comes back in
 * this answer and never again), change which events it hears, replace its
 * secret (the old one keeps signing for a day), remove it, or send it a test
 * message now.
 */
export async function POST(request: NextRequest) {
  const guarded = await guardStoreWrite(request, "settings");
  if (!guarded.ok) return guarded.response;

  try {
    const loaded = await storeForEmail(guarded.ref);
    const store = loaded && !loaded.statsId ? await ensureStatsId(guarded.ref) : loaded;
    if (!store || !store.statsId) return Response.json({ ok: false, error: "none" }, { status: 400 });

    const action = text(guarded.body.action, 20);
    const id = text(guarded.body.id, 40);
    if (action === "add") {
      const result = await addEndpoint(store, text(guarded.body.url, MAX_ENDPOINT_URL + 1), guarded.body.events);
      if (!result.ok) return Response.json({ ok: false, error: result.reason, message: result.message }, { status: result.reason === "unavailable" ? 503 : result.reason === "paused" ? 409 : 400 });
      // Buyers' details can leave through a webhook, so every new one is
      // reported to the creator's inbox (lib/account-notice.ts).
      const added = result.view.endpoints[result.view.endpoints.length - 1];
      after(() => noticeCreator(store, { kind: "webhook-added", where: added?.where ?? "a new address" }));
      return Response.json({ ok: true, secret: result.secret, view: result.view });
    }
    if (action === "events") {
      const result = await setEndpointEvents(store, id, guarded.body.events);
      if (result === "unavailable") return Response.json({ ok: false, error: "unavailable", message: "The endpoint events could not be changed just now. Try again in a moment." }, { status: 503 });
      if (result === "events") return Response.json({ ok: false, error: "events" }, { status: 400 });
      if (result === "missing") return Response.json({ ok: false, error: "missing" }, { status: 404 });
      return Response.json({ ok: true, view: result });
    }
    if (action === "rotate") {
      // 378 [TB4]: a new secret, shown this once; the old one signs beside it for a day.
      const result = await rotateSecret(store, id);
      if (!result.ok) return Response.json({ ok: false, error: result.reason }, { status: 404 });
      return Response.json({ ok: true, secret: result.secret, oldSecretUntil: result.oldSecretUntil, view: result.view });
    }
    if (action === "remove") {
      const before = (await webhooksView(store)).endpoints.find((e) => e.id === id);
      const view = await removeEndpoint(store, id);
      if (before) after(() => noticeCreator(store, { kind: "webhook-removed", where: before.where }));
      return Response.json({ ok: true, view });
    }
    if (action === "test") {
      // 232 [CA1] 4b4b1: no test message while the plan's costs are paused; changing and removing stay open.
      const paused = integrationPauseWord(store);
      if (paused) return Response.json({ ok: false, error: paused, message: WEBHOOK_TEST_PAUSED_WORDS[paused] }, { status: 409 });
      const result = await sendTest(store, id);
      if (!result.ok) {
        if (result.reason === "unavailable") return Response.json({ ok: false, error: "unavailable", message: "The test could not be sent just now. Try again in a moment." }, { status: 503 });
        if (result.reason === "used") return Response.json({ ok: false, error: "used", message: result.message }, { status: 429 });
        return Response.json({ ok: false, error: result.reason }, { status: result.reason === "limited" ? 429 : 404 });
      }
      return Response.json({
        ok: true,
        delivered: result.delivery.state === "delivered",
        status: result.delivery.lastStatus,
        message: result.delivery.lastError,
        view: result.view,
      });
    }
    if (action === "resend") {
      // 378 [TB4] unit 3: a failed delivery sent again by hand, once. Paused like a test while the plan's costs are paused.
      const paused = integrationPauseWord(store);
      if (paused) return Response.json({ ok: false, error: paused, message: WEBHOOK_TEST_PAUSED_WORDS[paused] }, { status: 409 });
      const result = await resendDelivery(store, text(guarded.body.delivery, 40));
      if (!result.ok) {
        if (result.reason === "unavailable") return Response.json({ ok: false, error: "unavailable", message: "It could not be sent again just now. Try again in a moment." }, { status: 503 });
        if (result.reason === "used") return Response.json({ ok: false, error: "used", message: result.message }, { status: 429 });
        if (result.reason === "paused") return Response.json({ ok: false, error: "paused", message: result.message }, { status: 409 });
        if (result.reason === "limited") return Response.json({ ok: false, error: "limited" }, { status: 429 });
        return Response.json({ ok: false, error: result.reason }, { status: result.reason === "missing" ? 404 : 409 });
      }
      return Response.json({ ok: true, delivered: result.delivery.state === "delivered", status: result.delivery.lastStatus, message: result.delivery.lastError, view: result.view });
    }
    return Response.json({ ok: false, error: "invalid" }, { status: 400 });
  } catch (error) {
    console.error("changing webhooks failed", error);
    return Response.json({ ok: false, error: "server_error" }, { status: 500 });
  }
}
