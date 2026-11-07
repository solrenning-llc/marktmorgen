import type { NextRequest } from "next/server";
import { guardStoreWrite, text } from "@/lib/store-request";
import { BROADCAST_ID, readBroadcast } from "@/lib/broadcasts";
import { letterIdFor, publishLetter, unpublishLetter } from "@/lib/letters";

/**
 * Publishing a sent email on the store, or taking it off (lib/letter-rules.ts),
 * for a role that may email people for the store ("send"):
 *
 *   { action: "publish" | "unpublish", id, products? }   id: the sent email's own id;
 *   products: an array of the ids of this store's products that open its words, [] for
 *   everyone; left out, an email already kept for members stays so; anything else is refused.
 *   open: true, only to open an email already kept for members to everyone with products: []
 *   preview: how many of its first parts everyone may see (1 to LETTER_PREVIEW_MAX, 0 for none),
 *   only with products; left out, a kept preview stays when the products do; anything else is refused.
 *
 * Answers `{ ok, path? }` or `{ ok: false, error, message }`.
 */
export async function POST(request: NextRequest) {
  const guarded = await guardStoreWrite(request, "send", 2_000);
  if (!guarded.ok) return guarded.response;
  const { body, store } = guarded;
  const refuse = (error: string, message: string, status = 400) => Response.json({ ok: false, error, message }, { status });
  try {
    const action = text(body.action, 20);
    const id = text(body.id, 40);
    if (!BROADCAST_ID.test(id) || !store.sid) return refuse("invalid", "That email is not one of this store's. Reload the page.");
    if (action === "publish") {
      const broadcast = await readBroadcast(id);
      if (!broadcast || broadcast.listId !== store.listId) return refuse("gone", "That email is not one of this store's. Reload the page.", 404);
      const done = await publishLetter(store, broadcast, Date.now(), body.products, body.open === true, body.preview);
      if (!done.ok) return refuse(done.reason, done.message, done.reason === "unavailable" ? 503 : 409);
      return Response.json({ ok: true, path: `/@${store.handle}/letters/${done.letter.id}` });
    }
    if (action === "unpublish") {
      await unpublishLetter(store, letterIdFor(store.sid, id));
      return Response.json({ ok: true });
    }
    return refuse("invalid", "That is not something this page can do.");
  } catch (error) {
    console.error("publishing an email failed", error);
    return refuse("server_error", "That could not be done right now. Try again in a minute.", 500);
  }
}
