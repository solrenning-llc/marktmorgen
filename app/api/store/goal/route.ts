import type { NextRequest } from "next/server";
import { guardStoreWrite } from "@/lib/store-request";
import { ensureStatsId } from "@/lib/store";
import { setSalesGoal } from "@/lib/sales-goal";

/**
 * The month's goal (lib/sales-goal-rules.ts): `{ cents }` in the store's
 * currency's smallest unit, 0 for none. For whoever may see the numbers.
 */
export async function POST(request: NextRequest) {
  const guarded = await guardStoreWrite(request, "stats", 500);
  if (!guarded.ok) return guarded.response;
  try {
    const store = guarded.store.statsId ? guarded.store : await ensureStatsId(guarded.ref);
    if (!store?.statsId) return Response.json({ ok: false, error: "unavailable" }, { status: 503 });
    const goal = await setSalesGoal(store.statsId, guarded.body.cents, store.currency);
    if (goal === null) return Response.json({ ok: false, error: "invalid" }, { status: 400 });
    return Response.json({ ok: true, goal }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    console.error("setting the month's goal failed", error);
    return Response.json({ ok: false, error: "server_error" }, { status: 500 });
  }
}
