import type { NextRequest } from "next/server";
import { guardStoreWrite, text } from "@/lib/store-request";
import { BookBusy } from "@/lib/agent-book";
import { BATCH_MAX } from "@/lib/agent-proposal-rules";
import { confirmFor, declineFor, undoFor } from "@/lib/agent-confirm";
import { DataRoomError } from "@/lib/store-data";

/**
 * The creator confirming, declining or undoing what the AI agent prepared
 * (631 [AA1] (c), lib/agent-confirm.ts), for a role that may change the
 * store's settings:
 *
 *   { action: "confirm", ids: [...] }   carried out, each into the history
 *   { action: "decline", id }           taken off without carrying it out
 *   { action: "undo", id }              a confirmed change put back
 *
 * Never reachable by an agent's key: this is the creator's own act.
 */
const ID = /^[0-9a-f]{16}$/;

export async function POST(request: NextRequest) {
  const guarded = await guardStoreWrite(request, "settings");
  if (!guarded.ok) return guarded.response;
  const { body, store, ref, email } = guarded;
  const refuse = (error: string, message: string, status = 400) => Response.json({ ok: false, error, message }, { status });
  if (!store.statsId) return refuse("none", "Nothing has been proposed for this store yet.", 404);
  const book = { ...store, statsId: store.statsId };
  const action = text(body.action, 10);
  try {
    if (action === "confirm") {
      const ids = Array.isArray(body.ids) ? body.ids.slice(0, BATCH_MAX + 1).map((id) => text(id, 20)).filter((id) => ID.test(id)) : [];
      if (!ids.length) return refuse("ids", "Choose what to confirm.");
      return Response.json({ ok: true, ...(await confirmFor(book, ref, ids, email)) });
    }
    if (action === "decline") {
      const id = text(body.id, 20);
      return (await declineFor(book, id)) ? Response.json({ ok: true }) : refuse("unknown", "That proposal is not waiting any more. Reload the page.", 404);
    }
    if (action === "undo") {
      const done = await undoFor(book, ref, text(body.id, 20), email);
      if (done.ok) return Response.json({ ok: true });
      const words = {
        unknown: "That change is not in the history any more. Reload the page.",
        cannot_undo: "That kind of change cannot be put back.",
        already_undone: "That change was already put back.",
        too_old: "That change is too old to put back here.",
        changed_since: "It was changed again since, so putting it back would undo that too. Nothing was changed.",
        failed: "It could not be put back just now. Try again in a moment.",
      } as const;
      return refuse(done.error, words[done.error], 409);
    }
    return refuse("invalid", "That is not something this page can do.");
  } catch (error) {
    if (error instanceof BookBusy) return refuse("busy", "Another change to these proposals is being made right now. Try again in a moment.", 409);
    if (error instanceof DataRoomError) return refuse("full", "Your store has no room for this change right now.", 409);
    console.error("an action on the agent's proposals failed", error);
    return refuse("server_error", "That could not be done just now. Try again in a moment.", 500);
  }
}
