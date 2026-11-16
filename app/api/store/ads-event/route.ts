import { withinStore } from "@/lib/metered-limits";
import type { NextRequest } from "next/server";
import { normaliseHandle, storeForHandle } from "@/lib/store";
import { clientAddress, fromAnotherSite, limited } from "@/lib/request-guard";
import { clientIp } from "@/lib/visit";
import { openAdEventRelay, sendServerPurchase } from "@/lib/ad-events";
import { hasPixels } from "@/lib/pixels";

/** The store's handle and a relay handle at its longest (lib/ad-events.ts AD_EVENT_RELAY_MAX), with room. */
const MAX_BODY_BYTES = 600;
const done = () => new Response(null, { status: 204, headers: { "Cache-Control": "no-store" } });

/**
 * The buyer's browser, after its pixels fired a purchase, asking for the same
 * purchase to be sent from the server too (lib/ad-events.ts): `{ h, t }`,
 * the store and the relay handle the thanks page sealed for it
 * (adEventRelay). Never the checkout's own id: that is a key to the order and
 * the browser is not given it (review of #2557), so one sent here, under any
 * name, is ignored. Asked only by a browser whose pixels were allowed to run.
 * The answer is always empty: nothing in it is the caller's business.
 */
export async function POST(request: NextRequest) {
  if (fromAnotherSite(request)) return done();
  if (Number(request.headers.get("content-length") ?? "0") > MAX_BODY_BYTES) return done();
  let body: Record<string, unknown> = {};
  try {
    const parsed = JSON.parse(await (await limited(request, MAX_BODY_BYTES)).text()) as unknown;
    if (parsed && typeof parsed === "object") body = parsed as Record<string, unknown>;
  } catch {
    return done();
  }
  const handle = normaliseHandle(typeof body.h === "string" ? body.h.slice(0, 40) : "");
  if (!handle) return done();
  const store = await storeForHandle(handle).catch(() => null);
  if (!store || !hasPixels(store.pixels)) return done();
  if (!(await withinStore("ads-event", `${clientAddress(request)}|${store.handle}`, 10, 600, store))) return done();
  // The page the purchase was on, without its query, which names the order.
  let url = "";
  try {
    const page = new URL(request.headers.get("referer") ?? "");
    url = `${page.origin}${page.pathname}`;
  } catch {
    url = "";
  }
  const cookie = (name: string) => request.cookies.get(name)?.value?.slice(0, 300) ?? "";
  const cookies: Record<string, string> = {};
  for (const name of ["_fbp", "_fbc", "_ttp", "ttclid", "_epik", "_ga"]) if (cookie(name)) cookies[name] = cookie(name);
  // Opened for this store only, within its hour; anything else is nothing to send.
  const sessionId = openAdEventRelay(body.t, store.handle);
  if (!sessionId) return done();
  await sendServerPurchase(store, sessionId, {
    ip: clientIp(request),
    userAgent: (request.headers.get("user-agent") ?? "").slice(0, 500),
    url,
    cookies,
  }).catch((error) => console.error("sending a purchase from the server failed", error));
  return done();
}
