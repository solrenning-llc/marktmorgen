import type { NextRequest } from "next/server";
import { guardStoreWrite } from "@/lib/store-request";
import { ensureStatsId } from "@/lib/store";
import { addSpend, removeSpend } from "@/lib/ad-spend";
import { UnknownReplyError } from "@/lib/redis-reply";

/**
 * What the creator spent on ads (lib/ad-spend-rules.ts):
 * `{ action: "add", channel, campaign, cents, from, to }` adds a line,
 * `{ action: "remove", id }` takes one away. For whoever may see the numbers.
 * Answers the list as it is after.
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
      return Response.json({ ok: true, spends: added.spends, spendsUnread: added.metaUnread }, { headers: { "Cache-Control": "no-store" } });
    }
    if (body.action === "remove") {
      const read = await removeSpend(store.statsId, body.id);
      return Response.json({ ok: true, spends: read.spends, spendsUnread: read.metaUnread }, { headers: { "Cache-Control": "no-store" } });
    }
    return Response.json({ ok: false, error: "invalid" }, { status: 400 });
  } catch (error) {
    // The typed lines could not be read back (CX-123 rule 24): said so, never answered as an empty list.
    if (error instanceof UnknownReplyError) return Response.json({ ok: false, error: "unread" }, { status: 503 });
    console.error("changing an ad spend line failed", error);
    return Response.json({ ok: false, error: "server_error" }, { status: 500 });
  }
}
