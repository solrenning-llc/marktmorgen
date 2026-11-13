import type { NextRequest } from "next/server";
import { guardStoreWrite } from "@/lib/store-request";
import { ensureStatsId } from "@/lib/store";
import { UnreadableSpendsError, addSpend, removeSpend, removeUnreadableSpends } from "@/lib/ad-spend";
import { UnknownReplyError } from "@/lib/redis-reply";

/**
 * What the creator spent on ads (lib/ad-spend-rules.ts):
 * `{ action: "add", channel, campaign, cents, from, to }` adds a line,
 * `{ action: "remove", id }` takes one away, `{ action: "remove-unreadable" }`
 * takes away, by their keys, the kept entries that cannot be read (their
 * amounts unknown, never guessed). For whoever may see the numbers. Answers
 * the list as it is after; a list that cannot be read answers 503 `unread`,
 * with `unreadable` set to how many kept entries could not be read.
 */
export async function POST(request: NextRequest) {
  // Removing the entries that cannot be read deletes, so a session let in without its second step may not do it,
  // as it may not "remove" (lib/two-step.ts LOCKED_ACTIONS): it is named "remove" to the guard.
  const guarded = await guardStoreWrite(request, "stats", 1_000, (body) => (body.action === "remove-unreadable" ? "remove" : String(body.action ?? "").slice(0, 20)));
  if (!guarded.ok) return guarded.response;
  const { body } = guarded;
  try {
    const store = guarded.store.statsId ? guarded.store : await ensureStatsId(guarded.store.email);
    if (!store?.statsId) return Response.json({ ok: false, error: "unavailable" }, { status: 503 });
    if (body.action === "add") {
      // `op`: the add's operation id from the studio (components/ad-spend-editor.tsx), so a retried add stays one line.
      const added = await addSpend(store.statsId, { channel: body.channel, campaign: body.campaign, cents: body.cents, from: body.from, to: body.to, op: body.op });
      if (!added.ok) return Response.json({ ok: false, error: added.reason }, { status: added.reason === "unavailable" ? 503 : 400 });
      return Response.json({ ok: true, spends: added.spends, spendsUnread: added.metaUnread }, { headers: { "Cache-Control": "no-store" } });
    }
    if (body.action === "remove") {
      const read = await removeSpend(store.statsId, body.id);
      return Response.json({ ok: true, spends: read.spends, spendsUnread: read.metaUnread }, { headers: { "Cache-Control": "no-store" } });
    }
    if (body.action === "remove-unreadable") {
      const read = await removeUnreadableSpends(store.statsId);
      return Response.json({ ok: true, spends: read.spends, spendsUnread: read.metaUnread }, { headers: { "Cache-Control": "no-store" } });
    }
    return Response.json({ ok: false, error: "invalid" }, { status: 400 });
  } catch (error) {
    // The typed lines could not be read back (CX-123 rule 24): said so, never answered as an empty list; entries that
    // read whole but are in another shape are counted, so the editor can offer to remove exactly those.
    if (error instanceof UnreadableSpendsError) return Response.json({ ok: false, error: "unread", unreadable: error.count }, { status: 503 });
    if (error instanceof UnknownReplyError) return Response.json({ ok: false, error: "unread" }, { status: 503 });
    console.error("changing an ad spend line failed", error);
    return Response.json({ ok: false, error: "server_error" }, { status: 500 });
  }
}
