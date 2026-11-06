import type { NextRequest } from "next/server";
import { guardStoreWrite } from "@/lib/store-request";
import { chooseAccount, isMetaConfigured, metaView, readMetaSpend } from "@/lib/meta-ads";
import { readSpends } from "@/lib/ad-spend";
import { costsPaused } from "@/lib/plan-standing";

/**
 * Which of the connected Meta ad accounts the numbers read
 * (lib/meta-ads.ts): `{ action: "account", id: "act_…" }`, for the owner and
 * Admins. It is read at once; answers the connection and every spend line as
 * they are after.
 */
export async function POST(request: NextRequest) {
  if (!isMetaConfigured()) return new Response("Not found.", { status: 404 });
  const guarded = await guardStoreWrite(request, "settings", 1_000);
  if (!guarded.ok) return guarded.response;
  const { body, store } = guarded;
  if (!store.statsId) return Response.json({ ok: false, error: "unavailable" }, { status: 503 });
  try {
    if (body.action !== "account") return Response.json({ ok: false, error: "invalid" }, { status: 400 });
    if (!(await chooseAccount(store.statsId, body.id))) return Response.json({ ok: false, error: "account" }, { status: 400 });
    // While the plan's costs are paused (232 [CA1] 4b3) the choice is saved and its read waits: readMetaSpend answers "paused".
    await readMetaSpend(store.statsId, store.currency).catch(() => "error");
    const [view, spends] = await Promise.all([metaView(store.statsId, store.currency), readSpends(store.statsId)]);
    return Response.json({ ok: true, meta: view ? { ...view, readPaused: costsPaused(store) } : view, spends }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    console.error("choosing the Meta ad account failed", error);
    return Response.json({ ok: false, error: "server_error" }, { status: 500 });
  }
}
