import type { NextRequest } from "next/server";
import { guardStoreWrite } from "@/lib/store-request";
import { ensureStatsId } from "@/lib/store";
import { addSpend, removeSpend } from "@/lib/ad-spend";

/**
 * What the creator spent on ads (lib/ad-spend-rules.ts):
 * `{ action: "add", channel, campaign, cents, from, to }` adds a line,
 * `{ action: "remove", id }` takes one away. For whoever may see the numbers.
 * Answers the list as it is after; a removal it cannot confirm answers
 * `{ ok: false, error: "unconfirmed" }` with status 503.
 */
export async function POST(request: NextRequest) {
  const guarded = await guardStoreWrite(request, "stats", 1_000);
  if (!guarded.ok) return guarded.response;
  const { body } = guarded;
  try {
    const store = guarded.store.statsId ? guarded.store : await ensureStatsId(guarded.store.email);
    if (!store?.statsId) return Response.json({ ok: false, error: "unavailable" }, { status: 503 });
    if (body.action === "add") {
      const added = await addSpend(store.statsId, { channel: body.channel, campaign: body.campaign, cents: body.cents, from: body.from, to: body.to });
      if (!added.ok) return Response.json({ ok: false, error: added.reason }, { status: added.reason === "unavailable" ? 503 : 400 });
      return Response.json({ ok: true, spends: added.spends }, { headers: { "Cache-Control": "no-store" } });
    }
    if (body.action === "remove") {
      const removed = await removeSpend(store.statsId, body.id);
      // An unconfirmed removal is an error the owner can retry, never ok over a line that may still count.
      if (!removed.ok) return Response.json({ ok: false, error: removed.reason }, { status: 503, headers: { "Cache-Control": "no-store" } });
      return Response.json({ ok: true, spends: removed.spends }, { headers: { "Cache-Control": "no-store" } });
    }
    return Response.json({ ok: false, error: "invalid" }, { status: 400 });
  } catch (error) {
    console.error("changing an ad spend line failed", error);
    return Response.json({ ok: false, error: "server_error" }, { status: 500 });
  }
}
