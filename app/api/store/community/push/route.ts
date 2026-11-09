import type { NextRequest } from "next/server";
import { fromAnotherSite } from "@/lib/studio-route";
import { limited } from "@/lib/request-guard";
import { normaliseHandle, storeForHandle } from "@/lib/store";
import { communityViewer } from "@/lib/community-access";
import { memberKey } from "@/lib/community";
import { deviceCount, forgetDevice, rememberDevice, renewDevice } from "@/lib/community-push";
import { restingJson, takeBuyerAction } from "@/lib/buyer-actions";

/**
 * A member turning notifications on, or off, on one device.
 *
 * JSON rather than a form, because the browser's own subscription object is
 * what is being handed over and only a script can produce it. Everything else
 * in the community is a form; this one cannot be.
 *
 * `renew` comes from the service worker itself, when the browser swapped a
 * subscription out on its own (public/community-sw.js). It carries the same
 * cookie as any other request from that browser, so the person is known the
 * same way.
 */
export async function POST(request: NextRequest) {
  if (fromAnotherSite(request)) return new Response("forbidden", { status: 403 });
  // Read only as far as 8_000 bytes, whether or not a length was declared (docs/security-audit-2026-10-18.md, MM-SA-10).
  const body = (await limited(request, 8_000).then((r) => r.json()).catch(() => null)) as Record<string, unknown> | null;
  if (!body) return Response.json({ ok: false, error: "bad" }, { status: 400 });
  const text = (value: unknown, max: number) => (typeof value === "string" ? value.trim().slice(0, max) : "");

  const handle = normaliseHandle(text(body.handle, 60));
  const store = handle ? await storeForHandle(handle) : null;
  if (!store || !store.community) return Response.json({ ok: false, error: "none" }, { status: 404 });

  const viewer = await communityViewer(store, request.cookies);
  const id = store.community.id;
  const action = text(body.action, 20);
  // How many devices are left, when that reads (lib/community-push.ts deviceCount is exact); left out when it does
  // not, and the switch counts by itself.
  const left = (who: string) => deviceCount(id, who).catch(() => undefined);
  // Turning push off only deletes the signed-in person's own device, so it is taken whatever their membership:
  // somebody taken out by the creator, or whose ticket ended, can still stop their own device here.
  if (action === "off" && (viewer.state === "removed" || viewer.state === "closed")) {
    const who = memberKey(viewer.email);
    await forgetDevice(id, who, text(body.endpoint, 1_000), store);
    return Response.json({ ok: true, devices: await left(who) });
  }
  // Anything else only for somebody who is actually in. A device belongs to a
  // member of this community, and stops belonging the moment they stop being one.
  if (viewer.state !== "in") return Response.json({ ok: false, error: "out" }, { status: 403 });
  const who = viewer.key;
  // A device added is one of the store's buyer actions, or the creator's studio requests (lib/buyer-actions.ts); one taken off is not.
  if ((action === "on" || action === "renew") && !(await takeBuyerAction(store, viewer.owner ? "owner" : "buyer"))) return restingJson();

  if (action === "on") {
    const result = await rememberDevice(id, who, body.subscription, store);
    if (result === "invalid") return Response.json({ ok: false, error: "invalid" }, { status: 400 });
    if (result === "unavailable") return Response.json({ ok: false, error: "unavailable" }, { status: 503 });
    if (result === "full") return Response.json({ ok: false, error: "full" }, { status: 409 });
    // No room in the store's data room for one more device (lib/store-data.ts).
    if (result === "noroom") return Response.json({ ok: false, error: "noroom" }, { status: 409 });
    return Response.json({ ok: true, devices: await left(who) });
  }

  if (action === "renew") {
    await renewDevice(id, who, text(body.old, 1_000), body.subscription, store);
    return Response.json({ ok: true });
  }

  if (action === "off") {
    await forgetDevice(id, who, text(body.endpoint, 1_000), store);
    return Response.json({ ok: true, devices: await left(who) });
  }

  return Response.json({ ok: false, error: "unknown" }, { status: 400 });
}
