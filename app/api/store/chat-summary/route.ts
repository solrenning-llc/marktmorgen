import type { NextRequest } from "next/server";
import { guardStoreWrite } from "@/lib/store-request";
import { setChatAddress } from "@/lib/chat-summary";
import { withinEssentialLimit } from "@/lib/request-guard";
import { ensureStatsId, setChatSales } from "@/lib/store";

/**
 * Where the weekly and monthly numbers are posted (lib/chat-summary.ts):
 * `{ url }` keeps a Slack or Discord webhook address after a first message to
 * it went through, `{ url: "" }` forgets it. A setting, so for the owner and
 * an Admin.
 */
export async function POST(request: NextRequest) {
  const guarded = await guardStoreWrite(request, "settings", 1_000);
  if (!guarded.ok) return guarded.response;
  const { body, store } = guarded;
  // `{ sales: true | false }`: each sale and each alert posted too (lib/sale-events.ts, lib/store-alerts.ts).
  if ("sales" in body && !("url" in body)) {
    try {
      const next = await setChatSales(guarded.ref, body.sales === true);
      return next ? Response.json({ ok: true, sales: next.chatSales }) : Response.json({ ok: false, error: "none" }, { status: 400 });
    } catch (error) {
      console.error("setting chat posts for each sale failed", error);
      return Response.json({ ok: false, error: "server_error" }, { status: 500 });
    }
  }
  // Each save posts a first message, so saving is kept to a few an hour.
  if (!(await withinEssentialLimit("chat-summary", store.handle, 10, 3600))) return Response.json({ ok: false, error: "rate_limited" }, { status: 429 });
  try {
    const withStats = store.statsId ? store : await ensureStatsId(store.email);
    if (!withStats?.statsId) return Response.json({ ok: false, error: "unavailable" }, { status: 503 });
    const result = await setChatAddress(withStats.statsId, store.name, body.url);
    if (result === "invalid" || result === "refused") return Response.json({ ok: false, error: result }, { status: 400 });
    return Response.json({ ok: true, result }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    console.error("setting the chat summary failed", error);
    return Response.json({ ok: false, error: "server_error" }, { status: 500 });
  }
}
