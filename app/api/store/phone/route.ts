import { type NextRequest, after } from "next/server";
import { noticeCreator } from "@/lib/account-notice";
import { ensureStatsId } from "@/lib/store";
import { guardStoreWrite, text } from "@/lib/store-request";
import { addDevice, findDevice, removeDevice, renewDevice, sendTest, setDeviceEvents } from "@/lib/phone-alerts";

/** A subscription and a few words: well under this. */
const MAX_BODY_BYTES = 8_000;

/**
 * The devices that get the creator's notifications (lib/phone-alerts.ts):
 * turn one on (the browser's push subscription), find which one this browser
 * is, choose its events, send it a test, remove it, or take a subscription
 * the browser replaced by itself (from public/studio-sw.js). Nothing here
 * ever answers with a subscription's address.
 *
 * Each person's devices are their own (lib/phone-alerts.ts): anyone on the
 * store's team may turn notifications on for themselves, and every action
 * here reaches only the devices of the person asking, with the events their
 * role may hear.
 */
export async function POST(request: NextRequest) {
  // Anyone on the store, for their own devices (lib/studio-route.ts, "member"). A new device is "phone-add" to the
  // guard: a session let in without its second step may not add one (lib/two-step.ts LOCKED_ACTIONS, M3), since
  // it is told every sale and stays on after that session is logged out.
  const guarded = await guardStoreWrite(request, "member", MAX_BODY_BYTES, (body) => (body.action === "add" ? "phone-add" : String(body.action ?? "")));
  if (!guarded.ok) return guarded.response;
  const { email: who, role } = guarded;

  try {
    const loaded = guarded.store;
    const store = loaded.statsId ? loaded : await ensureStatsId(guarded.ref);
    if (!store || !store.statsId) return Response.json({ ok: false, error: "none" }, { status: 400 });

    const body = guarded.body;
    const action = text(body.action, 20);
    const id = text(body.id, 40);
    if (action === "add") {
      const result = await addDevice(store, who, role, body.subscription, body.events, request.headers.get("user-agent") ?? "");
      if (!result.ok) return Response.json({ ok: false, error: result.reason }, { status: result.reason === "unavailable" ? 503 : 400 });
      // Every sale is told to it, so a new device is reported to the
      // owner's inbox (lib/account-notice.ts), saying whose it is when it is
      // someone else's on the team.
      const label = role === "owner" ? result.label : `${result.label}, for ${who}`;
      if (result.created) after(() => noticeCreator(store, { kind: "phone-added", label }));
      return Response.json({ ok: true, id: result.id, view: result.view });
    }
    if (action === "find") {
      return Response.json({ ok: true, id: await findDevice(store, who, text(body.endpoint, 1000)) });
    }
    if (action === "events") {
      const view = await setDeviceEvents(store, who, role, id, body.events);
      if (view === "missing") return Response.json({ ok: false, error: "missing" }, { status: 404 });
      return Response.json({ ok: true, view });
    }
    if (action === "test") {
      const result = await sendTest(store, who, role, id);
      if (!result.ok) return Response.json({ ok: false, error: result.reason }, { status: result.reason === "limited" ? 429 : result.reason === "stale" ? 409 : 404 });
      return Response.json({ ok: true, delivered: result.state.ok, message: result.state.error, view: result.view });
    }
    if (action === "remove") {
      return Response.json({ ok: true, view: await removeDevice(store, who, role, id) });
    }
    if (action === "renew") {
      const result = await renewDevice(store, who, text(body.old, 1000), body.subscription);
      return Response.json({ ok: result === "renewed", error: result === "renewed" ? undefined : result }, { status: result === "renewed" ? 200 : 400 });
    }
    return Response.json({ ok: false, error: "invalid" }, { status: 400 });
  } catch (error) {
    console.error("changing phone notifications failed", error);
    return Response.json({ ok: false, error: "server_error" }, { status: 500 });
  }
}
