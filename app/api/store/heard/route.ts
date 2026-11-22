import { withinStore } from "@/lib/metered-limits";
import type { NextRequest } from "next/server";
import { normaliseHandle, storeForHandle } from "@/lib/store";
import { clientAddress, fromAnotherSite, limited, unknownLimit } from "@/lib/request-guard";
import { recordHeard } from "@/lib/heard";

const MAX_BODY_BYTES = 600;

/**
 * A buyer's answer to "where did you hear about us?" (lib/heard.ts), from
 * the page they landed on after paying: `{ h: handle, s: session_id, a: answer }`.
 * Counted once for a paid order of this store; says only whether it was.
 */
export async function POST(request: NextRequest) {
  const answer = (ok: boolean, status = 200) => Response.json({ ok }, { status, headers: { "Cache-Control": "no-store" } });
  if (fromAnotherSite(request)) return answer(false, 403);
  if (Number(request.headers.get("content-length") ?? "0") > MAX_BODY_BYTES) return answer(false, 413);
  let body: Record<string, unknown> = {};
  try {
    const raw = await (await limited(request, MAX_BODY_BYTES)).text();
    const parsed = JSON.parse(raw) as unknown;
    if (parsed && typeof parsed === "object") body = parsed as Record<string, unknown>;
  } catch {
    return answer(false, 400);
  }
  const handle = normaliseHandle(typeof body.h === "string" ? body.h.slice(0, 40) : "");
  if (!handle) return answer(false, 400);
  const store = await storeForHandle(handle).catch(() => null);
  if (!store) return answer(false, 404);
  // Each answer asks the creator's Stripe account about the order, so a few a connection.
  const room = await withinStore("heard", `${clientAddress(request)}|${store.handle}`, 20, 600, store).catch(unknownLimit);
  if (room === "unknown") return answer(false, 503);
  if (!room) return answer(false, 429);
  const result = await recordHeard(store, body.s, body.a).catch(() => "unavailable" as const);
  return answer(result === "counted" || result === "already", result === "invalid" ? 400 : result === "unavailable" ? 503 : 200);
}
