import { withinStore } from "@/lib/metered-limits";
import type { NextRequest } from "next/server";
import { normaliseHandle, storeForHandle } from "@/lib/store";
import { clientAddress, fromAnotherSite, limited, unknownLimit } from "@/lib/request-guard";
import { dismissNextOffer } from "@/lib/next-offer";

const MAX_BODY_BYTES = 600;

/**
 * The buyer's "no thanks" to the next product the Store assistant suggests
 * after a purchase (lib/next-offer.ts), from the page they landed on after
 * paying: `{ h: handle, s: session_id }`. Only an order whose choice was
 * made is marked; nothing is created for an order that has none, and no
 * model is asked. A public request of the store's window.
 */
export async function POST(request: NextRequest) {
  const answer = (ok: boolean, status = 200) => Response.json({ ok }, { status, headers: { "Cache-Control": "no-store" } });
  if (fromAnotherSite(request)) return answer(false, 403);
  if (Number(request.headers.get("content-length") ?? "0") > MAX_BODY_BYTES) return answer(false, 413);
  let body: Record<string, unknown> = {};
  try {
    const parsed = JSON.parse(await (await limited(request, MAX_BODY_BYTES)).text()) as unknown;
    if (parsed && typeof parsed === "object") body = parsed as Record<string, unknown>;
  } catch {
    return answer(false, 400);
  }
  const handle = normaliseHandle(typeof body.h === "string" ? body.h.slice(0, 40) : "");
  if (!handle) return answer(false, 400);
  const store = await storeForHandle(handle).catch(() => null);
  if (!store) return answer(false, 404);
  const room = await withinStore("assist-next-dismiss", `${clientAddress(request)}|${store.handle}`, 20, 600, store, "buyer").catch(unknownLimit);
  if (room === "unknown") return answer(false, 503);
  if (!room) return answer(false, 429);
  const done = await dismissNextOffer(store, body.s).catch(() => false);
  return answer(done, done ? 200 : 404);
}
