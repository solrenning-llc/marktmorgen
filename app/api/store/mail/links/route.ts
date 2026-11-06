import type { NextRequest } from "next/server";
import { StoreFullError } from "@/lib/store";
import { guardStoreWrite, text } from "@/lib/store-request";
import { readBroadcast } from "@/lib/broadcasts";
import { SENT_LINKS_MAX, SENT_LINK_MAX_LENGTH } from "@/lib/sent-link-rules";
import { CHANGE_REFUSALS, SentLinkWriteUnconfirmed, SentLinksUnreadable, changeLink } from "@/lib/sent-links";

const NO_STORE = { "Cache-Control": "private, no-store" };

/**
 * Sends one link of a sent one-off email somewhere else (124
 * [F2-EDIT-SENT-LINKS], lib/sent-links.ts):
 *
 *   { action: "link-change", id, n, to }
 *
 * answered with every change kept for that email, in order. Changing a link
 * back is a change to the address the email was sent with. What reaches the
 * list is for whoever may send ("send", lib/team-roles.ts). Only the store
 * settled by lib/studio-route.ts is ever touched: an email of another store
 * is refused as not this store's.
 */
export async function POST(request: NextRequest) {
  const guarded = await guardStoreWrite(request, "send", 4_000);
  if (!guarded.ok) return guarded.response;
  const { body, store } = guarded;
  if (body.action !== "link-change") return Response.json({ ok: false, error: "unknown" }, { status: 400 });
  const id = text(body.id, 24);
  const n = typeof body.n === "number" && Number.isSafeInteger(body.n) && body.n >= 0 && body.n < SENT_LINKS_MAX ? body.n : -1;
  const to = text(body.to, SENT_LINK_MAX_LENGTH + 1);
  try {
    const email = await readBroadcast(id);
    if (!email) return Response.json({ ok: false, error: "none", message: CHANGE_REFUSALS.none }, { status: 404, headers: NO_STORE });
    const done = await changeLink(store, email, n, to);
    if (!done.ok) return Response.json({ ok: false, error: done.reason, message: done.message }, { status: done.reason === "none" ? 404 : 400, headers: NO_STORE });
    return Response.json({ ok: true, changes: done.changes }, { headers: NO_STORE });
  } catch (error) {
    if (error instanceof StoreFullError) return Response.json({ ok: false, error: "data_full", message: "Your store has no room left for more records. Delete some you no longer need first." }, { status: 409, headers: NO_STORE });
    if (error instanceof SentLinkWriteUnconfirmed) return Response.json({ ok: false, error: "unconfirmed", message: "We could not confirm the change was saved. Reload the page to see where the link goes now." }, { status: 503, headers: NO_STORE });
    if (error instanceof SentLinksUnreadable) return Response.json({ ok: false, error: "unavailable", message: "The changes to this email could not be read just now, so nothing was changed. Try again in a moment." }, { status: 503, headers: NO_STORE });
    console.error("changing a sent link failed", error);
    return Response.json({ ok: false, error: "unavailable", message: "That did not work. Nothing was changed. Try again in a moment." }, { status: 503, headers: NO_STORE });
  }
}
