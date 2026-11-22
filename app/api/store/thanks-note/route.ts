import type { NextRequest } from "next/server";
import { StoreFullError } from "@/lib/store-full";
import { setProductNote } from "@/lib/store";
import { readListing } from "@/lib/catalog";
import { guardStoreWrite, text } from "@/lib/store-request";
import { readNote } from "@/lib/thanks-note";
import { writeThanksNote } from "@/lib/thanks-note-store";
import { heldRefusal } from "@/lib/child-safety";

/**
 * A product's note after paying (lib/thanks-note.ts), from the studio:
 * `{ id, note: { heading, body, video, label, url } }`, or `{ id, note: null }`
 * to take it off. Part of the product, so the products permission.
 */
export async function POST(request: NextRequest) {
  const guarded = await guardStoreWrite(request, "products", 12_000);
  if (!guarded.ok) return guarded.response;
  const id = text(guarded.body.id, 40);
  const store = guarded.store;
  const product = id ? await readListing(store, id) : null;
  if (!product) return Response.json({ ok: false, error: "unknown" }, { status: 400 });
  const onHold = await heldRefusal(guarded.store, id);
  if (onHold) return onHold;
  if (!store.statsId) return Response.json({ ok: false, error: "server_error" }, { status: 500 });
  const note = guarded.body.note === null ? null : readNote(guarded.body.note);
  if (typeof note === "string") return Response.json({ ok: false, error: note }, { status: 400 });
  try {
    // Written before the product says it has one, and forgotten after it says it has none.
    if (note) await writeThanksNote(store.statsId, id, note, store);
    const marked = await setProductNote(guarded.ref, id, note !== null);
    if (!marked.ok) return Response.json({ ok: false, error: marked.reason }, { status: 400 });
    if (!note) await writeThanksNote(store.statsId, id, null, store);
    return Response.json({ ok: true, note });
  } catch (error) {
    // What does not fit in the store's data room is not written (lib/store-data.ts).
    if (error instanceof StoreFullError) return Response.json({ ok: false, error: "store_full" }, { status: 409 });
    console.error("saving a note after paying failed", error);
    return Response.json({ ok: false, error: "server_error" }, { status: 500 });
  }
}
